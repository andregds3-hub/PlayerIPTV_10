"""Public API for TV devices.

This API is called by the TV app to:
1. Register a new device and get its activation code
2. Check device status and get Xtream configuration
3. Report heartbeat/last seen
"""
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db, Device, DeviceStatus, Settings

router = APIRouter(prefix="/api/v1", tags=["Device API"])

# Trial period in days (configurable via settings)
DEFAULT_TRIAL_DAYS = 7


class DeviceRegisterRequest(BaseModel):
    """Request to register a new device."""
    mac_address: str
    model: Optional[str] = None
    platform: Optional[str] = "tizen"
    app_version: Optional[str] = None


class DeviceRegisterResponse(BaseModel):
    """Response with device code and status."""
    code: str
    status: str
    trial_ends: Optional[str] = None
    expires_at: Optional[str] = None
    message: str


class DeviceStatusResponse(BaseModel):
    """Response with device status and configuration."""
    status: str
    trial_ends: Optional[str] = None
    expires_at: Optional[str] = None
    message: str
    # Xtream configuration (only if active)
    dns: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None


class HeartbeatRequest(BaseModel):
    """Device heartbeat."""
    app_version: Optional[str] = None


def get_trial_days(db: Session) -> int:
    """Get trial days from settings."""
    setting = db.query(Settings).filter(Settings.key == "trial_days").first()
    if setting:
        try:
            return int(setting.value)
        except:
            pass
    return DEFAULT_TRIAL_DAYS


def format_date(dt: Optional[datetime]) -> Optional[str]:
    """Format datetime for API response."""
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None


@router.post("/device/register", response_model=DeviceRegisterResponse)
async def register_device(request: DeviceRegisterRequest, db: Session = Depends(get_db)):
    """Register a new device or return existing one.
    
    Called when the TV app starts for the first time.
    Returns a unique code that the user shows to the reseller.
    """
    # Check if device already exists by MAC address
    device = db.query(Device).filter(Device.mac_address == request.mac_address).first()
    
    if device:
        # Update last seen and app version
        device.last_seen = datetime.utcnow()
        if request.app_version:
            device.app_version = request.app_version
        if request.model and not device.model:
            device.model = request.model
        db.commit()
        
        return DeviceRegisterResponse(
            code=device.code,
            status=device.status.value,
            trial_ends=format_date(device.trial_ends),
            expires_at=format_date(device.expires_at),
            message=_get_status_message(device)
        )
    
    # Generate unique code
    for _ in range(10):  # Try up to 10 times to get unique code
        code = Device.generate_code()
        if not db.query(Device).filter(Device.code == code).first():
            break
    else:
        raise HTTPException(status_code=500, detail="Failed to generate unique code")
    
    # Create new device with trial
    trial_days = get_trial_days(db)
    trial_ends = datetime.utcnow() + timedelta(days=trial_days) if trial_days > 0 else None
    
    device = Device(
        code=code,
        mac_address=request.mac_address,
        model=request.model,
        platform=request.platform,
        app_version=request.app_version,
        status=DeviceStatus.TRIAL if trial_days > 0 else DeviceStatus.EXPIRED,
        trial_ends=trial_ends,
        last_seen=datetime.utcnow()
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    
    return DeviceRegisterResponse(
        code=device.code,
        status=device.status.value,
        trial_ends=format_date(device.trial_ends),
        message=_get_status_message(device)
    )


@router.get("/device/{code}/status", response_model=DeviceStatusResponse)
async def get_device_status(code: str, db: Session = Depends(get_db)):
    """Get device status and configuration.
    
    Called periodically by the TV app to:
    - Check if device is still active
    - Get/update Xtream configuration
    """
    device = db.query(Device).filter(Device.code == code.upper()).first()
    
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    # Update last seen
    device.last_seen = datetime.utcnow()
    
    # Check and update status based on expiration
    _update_device_status(device)
    db.commit()
    
    # Build response
    response = DeviceStatusResponse(
        status=device.status.value,
        trial_ends=format_date(device.trial_ends),
        expires_at=format_date(device.expires_at),
        message=_get_status_message(device)
    )
    
    # Only include Xtream config if device is active/trial
    if device.status in (DeviceStatus.ACTIVE, DeviceStatus.TRIAL):
        if device.dns:
            response.dns = device.dns
            response.username = device.xtream_username
            response.password = device.xtream_password
    
    return response


@router.post("/device/{code}/heartbeat")
async def device_heartbeat(code: str, request: HeartbeatRequest, db: Session = Depends(get_db)):
    """Report device is alive.
    
    Called periodically by the TV app.
    """
    device = db.query(Device).filter(Device.code == code.upper()).first()
    
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    device.last_seen = datetime.utcnow()
    if request.app_version:
        device.app_version = request.app_version
    
    _update_device_status(device)
    db.commit()
    
    return {"status": "ok"}


def _update_device_status(device: Device) -> None:
    """Update device status based on expiration dates."""
    now = datetime.utcnow()
    
    if device.status == DeviceStatus.BLOCKED:
        return  # Blocked devices stay blocked
    
    # Check active subscription
    if device.expires_at:
        if now > device.expires_at:
            device.status = DeviceStatus.EXPIRED
        elif device.status != DeviceStatus.ACTIVE:
            device.status = DeviceStatus.ACTIVE
        return
    
    # Check trial
    if device.trial_ends:
        if now > device.trial_ends:
            device.status = DeviceStatus.EXPIRED
        elif device.status != DeviceStatus.TRIAL:
            device.status = DeviceStatus.TRIAL


def _get_status_message(device: Device) -> str:
    """Get user-friendly status message."""
    now = datetime.utcnow()
    
    if device.status == DeviceStatus.BLOCKED:
        return "Dispositivo bloqueado. Entre em contato com o suporte."
    
    if device.status == DeviceStatus.EXPIRED:
        return "Assinatura expirada. Renove para continuar usando."
    
    if device.status == DeviceStatus.TRIAL:
        if device.trial_ends:
            days_left = (device.trial_ends - now).days
            if days_left <= 0:
                return "Período de teste expirando hoje."
            elif days_left == 1:
                return "Período de teste: 1 dia restante."
            else:
                return f"Período de teste: {days_left} dias restantes."
        return "Período de teste ativo."
    
    if device.status == DeviceStatus.ACTIVE:
        if device.expires_at:
            days_left = (device.expires_at - now).days
            if days_left <= 0:
                return "Assinatura expirando hoje."
            elif days_left <= 7:
                return f"Assinatura ativa: {days_left} dias restantes."
            else:
                return f"Assinatura ativa até {device.expires_at.strftime('%d/%m/%Y')}."
        return "Assinatura ativa."
    
    return "Status desconhecido."
