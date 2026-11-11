"""PlayerIPTV Activation Panel - Main Application.

A licensing and activation system for PlayerIPTV similar to:
- Smarters Player Lite
- Duplex Play
- IBO Player

Features:
- Device activation with unique codes
- Reseller system with credits
- Pix payment integration
- Master admin panel
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from .database import init_db, SessionLocal, User, UserRole, Settings, Plan, CreditPackage
from .auth import get_password_hash
from .routers import api, master, reseller, auth_routes


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    init_db()
    create_initial_data()
    yield


app = FastAPI(
    title="PlayerIPTV Panel",
    description="Sistema de ativação e gerenciamento de licenças",
    version="1.0.0",
    lifespan=lifespan
)

# Mount static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

# Include routers
app.include_router(auth_routes.router)
app.include_router(api.router)
app.include_router(master.router)
app.include_router(reseller.router)


def create_initial_data():
    """Create initial master user and default data if not exists."""
    db = SessionLocal()
    try:
        # Create master user if not exists
        master_user = db.query(User).filter(User.role == UserRole.MASTER).first()
        if not master_user:
            admin_password = os.getenv("ADMIN_PASSWORD", "admin123")
            master_user = User(
                username="admin",
                email="admin@playeriptv.local",
                password_hash=get_password_hash(admin_password),
                role=UserRole.MASTER,
                name="Administrador",
                is_active=True
            )
            db.add(master_user)
            print(f"[SETUP] Master user created: admin / {admin_password}")
        
        # Create default settings if not exists
        default_settings = {
            "trial_days": "7",
            "app_name": "PlayerIPTV",
            "support_email": "suporte@playeriptv.local",
            "support_whatsapp": "",
            "pix_key": "",
            "pix_name": "",
        }
        for key, value in default_settings.items():
            if not db.query(Settings).filter(Settings.key == key).first():
                db.add(Settings(key=key, value=value))
        
        # Create default plans if none exist
        if not db.query(Plan).first():
            default_plans = [
                Plan(name="Mensal", days=30, credits_cost=1.0, price=15.0, sort_order=0),
                Plan(name="Trimestral", days=90, credits_cost=2.5, price=35.0, sort_order=1),
                Plan(name="Semestral", days=180, credits_cost=4.5, price=60.0, sort_order=2),
                Plan(name="Anual", days=365, credits_cost=8.0, price=100.0, sort_order=3),
            ]
            for plan in default_plans:
                db.add(plan)
            print("[SETUP] Default plans created")
        
        # Create default credit packages if none exist
        if not db.query(CreditPackage).first():
            default_packages = [
                CreditPackage(name="10 Créditos", credits=10, price=100.0, bonus_credits=0, sort_order=0),
                CreditPackage(name="25 Créditos", credits=25, price=225.0, bonus_credits=2, sort_order=1),
                CreditPackage(name="50 Créditos", credits=50, price=400.0, bonus_credits=5, sort_order=2),
                CreditPackage(name="100 Créditos", credits=100, price=700.0, bonus_credits=15, sort_order=3),
            ]
            for package in default_packages:
                db.add(package)
            print("[SETUP] Default credit packages created")
        
        db.commit()
    finally:
        db.close()


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """Redirect 404s to home."""
    return RedirectResponse(url="/")
