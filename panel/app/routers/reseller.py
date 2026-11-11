"""Reseller panel routes.

Resellers can:
- View their dashboard and stats
- Buy credits (via Pix)
- Activate devices using their credits
- Manage their devices
"""
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import (
    get_db, User, UserRole, Device, DeviceStatus,
    Transaction, TransactionType, Plan, CreditPackage, Payment
)
from ..auth import get_current_user, require_reseller
from ..templates import templates

router = APIRouter(prefix="/reseller", tags=["Reseller Panel"])


# ========== Dashboard ==========

@router.get("/", response_class=HTMLResponse)
async def reseller_dashboard(request: Request, user: User = Depends(require_reseller), db: Session = Depends(get_db)):
    """Reseller dashboard."""
    # If user is master, redirect to master dashboard
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/", status_code=303)
    
    # Statistics
    stats = {
        "credits": user.credits,
        "total_devices": db.query(Device).filter(Device.owner_id == user.id).count(),
        "active_devices": db.query(Device).filter(
            Device.owner_id == user.id,
            Device.status.in_([DeviceStatus.ACTIVE, DeviceStatus.TRIAL])
        ).count(),
        "expired_devices": db.query(Device).filter(
            Device.owner_id == user.id,
            Device.status == DeviceStatus.EXPIRED
        ).count(),
    }
    
    # Recent devices
    recent_devices = db.query(Device).filter(
        Device.owner_id == user.id
    ).order_by(Device.created_at.desc()).limit(10).all()
    
    # Recent transactions
    recent_transactions = db.query(Transaction).filter(
        Transaction.user_id == user.id
    ).order_by(Transaction.created_at.desc()).limit(10).all()
    
    return templates.TemplateResponse("reseller/dashboard.html", {
        "request": request,
        "user": user,
        "stats": stats,
        "recent_devices": recent_devices,
        "recent_transactions": recent_transactions
    })


# ========== Devices Management ==========

@router.get("/devices", response_class=HTMLResponse)
async def list_devices(
    request: Request,
    status_filter: Optional[str] = None,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """List reseller's devices."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/devices", status_code=303)
    
    query = db.query(Device).filter(Device.owner_id == user.id)
    
    if status_filter:
        try:
            status_enum = DeviceStatus(status_filter)
            query = query.filter(Device.status == status_enum)
        except:
            pass
    
    devices = query.order_by(Device.created_at.desc()).all()
    
    return templates.TemplateResponse("reseller/devices.html", {
        "request": request,
        "user": user,
        "devices": devices,
        "status_filter": status_filter,
        "statuses": [s.value for s in DeviceStatus]
    })


@router.get("/devices/activate", response_class=HTMLResponse)
async def activate_device_form(
    request: Request,
    code: Optional[str] = None,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Show device activation form."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/devices", status_code=303)
    
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.sort_order).all()
    device = None
    
    if code:
        device = db.query(Device).filter(Device.code == code.upper()).first()
    
    return templates.TemplateResponse("reseller/activate.html", {
        "request": request,
        "user": user,
        "device": device,
        "code": code,
        "plans": plans
    })


@router.post("/devices/activate")
async def activate_device(
    code: str = Form(...),
    plan_id: int = Form(...),
    dns: str = Form(None),
    xtream_username: str = Form(None),
    xtream_password: str = Form(None),
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Activate a device using credits."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/devices", status_code=303)
    
    # Find device
    device = db.query(Device).filter(Device.code == code.upper()).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado. Verifique o código.")
    
    # Check if device belongs to another reseller
    if device.owner_id and device.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Este dispositivo pertence a outro revendedor.")
    
    # Find plan
    plan = db.query(Plan).filter(Plan.id == plan_id, Plan.is_active == True).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plano não encontrado.")
    
    # Check credits
    if user.credits < plan.credits_cost:
        raise HTTPException(
            status_code=400, 
            detail=f"Créditos insuficientes. Você tem {user.credits:.2f}, precisa de {plan.credits_cost:.2f}."
        )
    
    # Deduct credits
    user.credits -= plan.credits_cost
    
    # Update device
    now = datetime.utcnow()
    is_renewal = device.status == DeviceStatus.ACTIVE and device.expires_at and device.expires_at > now
    
    if is_renewal:
        # Extend from current expiration
        device.expires_at = device.expires_at + timedelta(days=plan.days)
    else:
        # Start from now
        device.expires_at = now + timedelta(days=plan.days)
    
    device.status = DeviceStatus.ACTIVE
    device.owner_id = user.id
    
    if dns:
        device.dns = dns
    if xtream_username:
        device.xtream_username = xtream_username
    if xtream_password:
        device.xtream_password = xtream_password
    
    # Log transaction
    transaction = Transaction(
        user_id=user.id,
        type=TransactionType.RENEWAL if is_renewal else TransactionType.ACTIVATION,
        amount=-plan.credits_cost,
        balance_after=user.credits,
        reference_id=device.id,
        reference_type="device",
        description=f"{'Renovação' if is_renewal else 'Ativação'} {device.code} - {plan.name}"
    )
    db.add(transaction)
    db.commit()
    
    return RedirectResponse(url=f"/reseller/devices", status_code=303)


@router.get("/devices/{device_id}", response_class=HTMLResponse)
async def view_device(
    device_id: int,
    request: Request,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """View device details."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url=f"/master/devices/{device_id}", status_code=303)
    
    device = db.query(Device).filter(Device.id == device_id, Device.owner_id == user.id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.sort_order).all()
    
    return templates.TemplateResponse("reseller/device_detail.html", {
        "request": request,
        "user": user,
        "device": device,
        "plans": plans
    })


@router.post("/devices/{device_id}/config")
async def update_device_config(
    device_id: int,
    dns: str = Form(None),
    xtream_username: str = Form(None),
    xtream_password: str = Form(None),
    notes: str = Form(None),
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Update device Xtream configuration."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url=f"/master/devices/{device_id}", status_code=303)
    
    device = db.query(Device).filter(Device.id == device_id, Device.owner_id == user.id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    if dns is not None:
        device.dns = dns
    if xtream_username is not None:
        device.xtream_username = xtream_username
    if xtream_password is not None:
        device.xtream_password = xtream_password
    if notes is not None:
        device.notes = notes
    
    db.commit()
    
    return RedirectResponse(url=f"/reseller/devices/{device_id}", status_code=303)


# ========== Buy Credits ==========

@router.get("/credits", response_class=HTMLResponse)
async def credits_page(
    request: Request,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Credits purchase page."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/", status_code=303)
    
    packages = db.query(CreditPackage).filter(CreditPackage.is_active == True).order_by(CreditPackage.sort_order).all()
    
    # Recent payments
    recent_payments = db.query(Payment).filter(
        Payment.user_id == user.id
    ).order_by(Payment.created_at.desc()).limit(10).all()
    
    return templates.TemplateResponse("reseller/credits.html", {
        "request": request,
        "user": user,
        "packages": packages,
        "recent_payments": recent_payments
    })


@router.post("/credits/buy")
async def buy_credits(
    package_id: int = Form(...),
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Initiate credit purchase via Pix."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/", status_code=303)
    
    package = db.query(CreditPackage).filter(CreditPackage.id == package_id, CreditPackage.is_active == True).first()
    if not package:
        raise HTTPException(status_code=404, detail="Pacote não encontrado")
    
    # Create pending payment
    payment = Payment(
        user_id=user.id,
        package_id=package.id,
        amount=package.price,
        credits=package.credits + package.bonus_credits,
        status="pending",
        expires_at=datetime.utcnow() + timedelta(hours=24)
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    
    # TODO: Generate Pix code via payment gateway (Mercado Pago, PagSeguro, etc.)
    # For now, we'll use a placeholder
    payment.pix_code = f"00020126580014br.gov.bcb.pix0136{payment.id:08d}5204000053039865406{package.price:.2f}5802BR"
    db.commit()
    
    return RedirectResponse(url=f"/reseller/credits/payment/{payment.id}", status_code=303)


@router.get("/credits/payment/{payment_id}", response_class=HTMLResponse)
async def payment_page(
    payment_id: int,
    request: Request,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """Show Pix payment page."""
    payment = db.query(Payment).filter(Payment.id == payment_id, Payment.user_id == user.id).first()
    if not payment:
        raise HTTPException(status_code=404, detail="Pagamento não encontrado")
    
    package = db.query(CreditPackage).filter(CreditPackage.id == payment.package_id).first()
    
    return templates.TemplateResponse("reseller/payment.html", {
        "request": request,
        "user": user,
        "payment": payment,
        "package": package
    })


# ========== Transaction History ==========

@router.get("/transactions", response_class=HTMLResponse)
async def transaction_history(
    request: Request,
    user: User = Depends(require_reseller),
    db: Session = Depends(get_db)
):
    """View transaction history."""
    if user.role == UserRole.MASTER:
        return RedirectResponse(url="/master/", status_code=303)
    
    transactions = db.query(Transaction).filter(
        Transaction.user_id == user.id
    ).order_by(Transaction.created_at.desc()).all()
    
    return templates.TemplateResponse("reseller/transactions.html", {
        "request": request,
        "user": user,
        "transactions": transactions
    })
