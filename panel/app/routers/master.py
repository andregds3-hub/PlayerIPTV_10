"""Master panel routes.

Master can:
- Manage resellers (create, edit, block, add credits)
- View all devices
- Manage plans and credit packages
- Configure system settings
"""
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from sqlalchemy import func, and_

from ..database import (
    get_db, User, UserRole, Device, DeviceStatus, 
    Transaction, TransactionType, Plan, CreditPackage, Settings
)
from ..auth import get_current_user, require_master, get_password_hash
from ..templates import templates

router = APIRouter(prefix="/master", tags=["Master Panel"])


# ========== Dashboard ==========

@router.get("/", response_class=HTMLResponse)
async def master_dashboard(request: Request, user: User = Depends(require_master), db: Session = Depends(get_db)):
    """Master dashboard with statistics."""
    # Statistics
    stats = {
        "total_resellers": db.query(User).filter(User.role == UserRole.RESELLER).count(),
        "active_resellers": db.query(User).filter(
            User.role == UserRole.RESELLER, 
            User.is_active == True
        ).count(),
        "total_devices": db.query(Device).count(),
        "active_devices": db.query(Device).filter(
            Device.status.in_([DeviceStatus.ACTIVE, DeviceStatus.TRIAL])
        ).count(),
        "trial_devices": db.query(Device).filter(Device.status == DeviceStatus.TRIAL).count(),
        "expired_devices": db.query(Device).filter(Device.status == DeviceStatus.EXPIRED).count(),
        "total_credits_sold": db.query(func.sum(Transaction.amount)).filter(
            Transaction.type == TransactionType.PURCHASE,
            Transaction.amount > 0
        ).scalar() or 0,
    }
    
    # Recent devices
    recent_devices = db.query(Device).order_by(Device.created_at.desc()).limit(10).all()
    
    # Recent resellers
    recent_resellers = db.query(User).filter(
        User.role == UserRole.RESELLER
    ).order_by(User.created_at.desc()).limit(5).all()
    
    return templates.TemplateResponse("master/dashboard.html", {
        "request": request,
        "user": user,
        "stats": stats,
        "recent_devices": recent_devices,
        "recent_resellers": recent_resellers
    })


# ========== Resellers Management ==========

class CreateResellerRequest(BaseModel):
    username: str
    email: EmailStr
    password: str
    name: Optional[str] = None
    phone: Optional[str] = None
    initial_credits: float = 0


@router.get("/resellers", response_class=HTMLResponse)
async def list_resellers(request: Request, user: User = Depends(require_master), db: Session = Depends(get_db)):
    """List all resellers."""
    resellers = db.query(User).filter(User.role == UserRole.RESELLER).order_by(User.created_at.desc()).all()
    
    # Get device counts per reseller
    device_counts = {}
    for reseller in resellers:
        device_counts[reseller.id] = db.query(Device).filter(Device.owner_id == reseller.id).count()
    
    return templates.TemplateResponse("master/resellers.html", {
        "request": request,
        "user": user,
        "resellers": resellers,
        "device_counts": device_counts
    })


@router.get("/resellers/new", response_class=HTMLResponse)
async def new_reseller_form(request: Request, user: User = Depends(require_master)):
    """Show create reseller form."""
    return templates.TemplateResponse("master/reseller_form.html", {
        "request": request,
        "user": user,
        "reseller": None
    })


@router.post("/resellers")
async def create_reseller(
    request: Request,
    username: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    name: str = Form(None),
    phone: str = Form(None),
    initial_credits: float = Form(0),
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Create a new reseller."""
    # Check if username or email already exists
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="Nome de usuário já existe")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="Email já cadastrado")
    
    # Create reseller
    reseller = User(
        username=username,
        email=email,
        password_hash=get_password_hash(password),
        role=UserRole.RESELLER,
        name=name,
        phone=phone,
        credits=initial_credits,
        parent_id=user.id
    )
    db.add(reseller)
    db.commit()
    
    # Log initial credits if any
    if initial_credits > 0:
        transaction = Transaction(
            user_id=reseller.id,
            type=TransactionType.BONUS,
            amount=initial_credits,
            balance_after=initial_credits,
            description=f"Créditos iniciais",
            created_by_id=user.id
        )
        db.add(transaction)
        db.commit()
    
    return RedirectResponse(url="/master/resellers", status_code=303)


@router.get("/resellers/{reseller_id}", response_class=HTMLResponse)
async def view_reseller(
    reseller_id: int,
    request: Request,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """View reseller details."""
    reseller = db.query(User).filter(User.id == reseller_id, User.role == UserRole.RESELLER).first()
    if not reseller:
        raise HTTPException(status_code=404, detail="Revendedor não encontrado")
    
    # Get devices
    devices = db.query(Device).filter(Device.owner_id == reseller_id).order_by(Device.created_at.desc()).all()
    
    # Get transactions
    transactions = db.query(Transaction).filter(
        Transaction.user_id == reseller_id
    ).order_by(Transaction.created_at.desc()).limit(50).all()
    
    return templates.TemplateResponse("master/reseller_detail.html", {
        "request": request,
        "user": user,
        "reseller": reseller,
        "devices": devices,
        "transactions": transactions
    })


@router.post("/resellers/{reseller_id}/credits")
async def add_credits(
    reseller_id: int,
    amount: float = Form(...),
    description: str = Form(""),
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Add or remove credits from a reseller."""
    reseller = db.query(User).filter(User.id == reseller_id, User.role == UserRole.RESELLER).first()
    if not reseller:
        raise HTTPException(status_code=404, detail="Revendedor não encontrado")
    
    # Update credits
    reseller.credits += amount
    if reseller.credits < 0:
        reseller.credits = 0
    
    # Log transaction
    transaction = Transaction(
        user_id=reseller_id,
        type=TransactionType.BONUS if amount > 0 else TransactionType.REFUND,
        amount=amount,
        balance_after=reseller.credits,
        description=description or ("Créditos adicionados" if amount > 0 else "Créditos removidos"),
        created_by_id=user.id
    )
    db.add(transaction)
    db.commit()
    
    return RedirectResponse(url=f"/master/resellers/{reseller_id}", status_code=303)


@router.post("/resellers/{reseller_id}/toggle")
async def toggle_reseller(
    reseller_id: int,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Enable or disable a reseller."""
    reseller = db.query(User).filter(User.id == reseller_id, User.role == UserRole.RESELLER).first()
    if not reseller:
        raise HTTPException(status_code=404, detail="Revendedor não encontrado")
    
    reseller.is_active = not reseller.is_active
    db.commit()
    
    return RedirectResponse(url=f"/master/resellers/{reseller_id}", status_code=303)


# ========== Devices Management ==========

@router.get("/devices", response_class=HTMLResponse)
async def list_devices(
    request: Request,
    status_filter: Optional[str] = None,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """List all devices."""
    query = db.query(Device)
    
    if status_filter:
        try:
            status_enum = DeviceStatus(status_filter)
            query = query.filter(Device.status == status_enum)
        except:
            pass
    
    devices = query.order_by(Device.created_at.desc()).all()
    
    return templates.TemplateResponse("master/devices.html", {
        "request": request,
        "user": user,
        "devices": devices,
        "status_filter": status_filter,
        "statuses": [s.value for s in DeviceStatus]
    })


@router.get("/devices/{device_id}", response_class=HTMLResponse)
async def view_device(
    device_id: int,
    request: Request,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """View device details."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.sort_order).all()
    resellers = db.query(User).filter(User.role == UserRole.RESELLER, User.is_active == True).all()
    
    return templates.TemplateResponse("master/device_detail.html", {
        "request": request,
        "user": user,
        "device": device,
        "plans": plans,
        "resellers": resellers
    })


@router.post("/devices/{device_id}/activate")
async def activate_device(
    device_id: int,
    plan_id: int = Form(...),
    dns: str = Form(None),
    xtream_username: str = Form(None),
    xtream_password: str = Form(None),
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Activate a device (master doesn't spend credits)."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    plan = db.query(Plan).filter(Plan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plano não encontrado")
    
    # Update device
    now = datetime.utcnow()
    if device.expires_at and device.expires_at > now:
        # Extend from current expiration
        device.expires_at = device.expires_at + timedelta(days=plan.days)
    else:
        # Start from now
        device.expires_at = now + timedelta(days=plan.days)
    
    device.status = DeviceStatus.ACTIVE
    
    if dns:
        device.dns = dns
    if xtream_username:
        device.xtream_username = xtream_username
    if xtream_password:
        device.xtream_password = xtream_password
    
    db.commit()
    
    return RedirectResponse(url=f"/master/devices/{device_id}", status_code=303)


@router.post("/devices/{device_id}/block")
async def block_device(
    device_id: int,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Block a device."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    device.status = DeviceStatus.BLOCKED
    db.commit()
    
    return RedirectResponse(url=f"/master/devices/{device_id}", status_code=303)


@router.post("/devices/{device_id}/unblock")
async def unblock_device(
    device_id: int,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Unblock a device."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo não encontrado")
    
    # Determine new status based on expiration
    now = datetime.utcnow()
    if device.expires_at and device.expires_at > now:
        device.status = DeviceStatus.ACTIVE
    elif device.trial_ends and device.trial_ends > now:
        device.status = DeviceStatus.TRIAL
    else:
        device.status = DeviceStatus.EXPIRED
    
    db.commit()
    
    return RedirectResponse(url=f"/master/devices/{device_id}", status_code=303)


# ========== Plans Management ==========

@router.get("/plans", response_class=HTMLResponse)
async def list_plans(request: Request, user: User = Depends(require_master), db: Session = Depends(get_db)):
    """List all plans."""
    plans = db.query(Plan).order_by(Plan.sort_order).all()
    return templates.TemplateResponse("master/plans.html", {
        "request": request,
        "user": user,
        "plans": plans
    })


@router.post("/plans")
async def create_plan(
    name: str = Form(...),
    days: int = Form(...),
    credits_cost: float = Form(...),
    price: float = Form(None),
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Create a new plan."""
    plan = Plan(
        name=name,
        days=days,
        credits_cost=credits_cost,
        price=price,
        sort_order=db.query(Plan).count()
    )
    db.add(plan)
    db.commit()
    
    return RedirectResponse(url="/master/plans", status_code=303)


@router.post("/plans/{plan_id}/toggle")
async def toggle_plan(
    plan_id: int,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Enable or disable a plan."""
    plan = db.query(Plan).filter(Plan.id == plan_id).first()
    if plan:
        plan.is_active = not plan.is_active
        db.commit()
    
    return RedirectResponse(url="/master/plans", status_code=303)


# ========== Credit Packages ==========

@router.get("/packages", response_class=HTMLResponse)
async def list_packages(request: Request, user: User = Depends(require_master), db: Session = Depends(get_db)):
    """List credit packages."""
    packages = db.query(CreditPackage).order_by(CreditPackage.sort_order).all()
    return templates.TemplateResponse("master/packages.html", {
        "request": request,
        "user": user,
        "packages": packages
    })


@router.post("/packages")
async def create_package(
    name: str = Form(...),
    credits: float = Form(...),
    price: float = Form(...),
    bonus_credits: float = Form(0),
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Create a credit package."""
    package = CreditPackage(
        name=name,
        credits=credits,
        price=price,
        bonus_credits=bonus_credits,
        sort_order=db.query(CreditPackage).count()
    )
    db.add(package)
    db.commit()
    
    return RedirectResponse(url="/master/packages", status_code=303)


# ========== Settings ==========

@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request, user: User = Depends(require_master), db: Session = Depends(get_db)):
    """System settings page."""
    # Get all settings
    settings_list = db.query(Settings).all()
    settings = {s.key: s.value for s in settings_list}
    
    return templates.TemplateResponse("master/settings.html", {
        "request": request,
        "user": user,
        "settings": settings
    })


@router.post("/settings")
async def save_settings(
    request: Request,
    user: User = Depends(require_master),
    db: Session = Depends(get_db)
):
    """Save system settings."""
    form = await request.form()
    
    for key, value in form.items():
        setting = db.query(Settings).filter(Settings.key == key).first()
        if setting:
            setting.value = value
        else:
            setting = Settings(key=key, value=value)
            db.add(setting)
    
    db.commit()
    
    return RedirectResponse(url="/master/settings", status_code=303)
