"""Authentication routes (login, logout, register)."""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status, Request, Form, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from ..database import get_db, User, UserRole
from ..auth import verify_password, get_password_hash, create_access_token, get_current_user_optional
from ..templates import templates

router = APIRouter(tags=["Authentication"])


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, user: User = Depends(get_current_user_optional)):
    """Show login page."""
    # If already logged in, redirect to appropriate dashboard
    if user:
        if user.role == UserRole.MASTER:
            return RedirectResponse(url="/master/", status_code=303)
        return RedirectResponse(url="/reseller/", status_code=303)
    
    return templates.TemplateResponse("auth/login.html", {
        "request": request,
        "error": None
    })


@router.post("/login")
async def login(
    request: Request,
    response: Response,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db)
):
    """Process login."""
    # Find user
    user = db.query(User).filter(User.username == username).first()
    
    if not user or not verify_password(password, user.password_hash):
        return templates.TemplateResponse("auth/login.html", {
            "request": request,
            "error": "Usuário ou senha incorretos"
        })
    
    if not user.is_active:
        return templates.TemplateResponse("auth/login.html", {
            "request": request,
            "error": "Conta desativada. Entre em contato com o administrador."
        })
    
    # Update last login
    user.last_login = datetime.utcnow()
    db.commit()
    
    # Create token and set cookie
    token = create_access_token({"sub": str(user.id)})
    
    # Redirect based on role
    redirect_url = "/master/" if user.role == UserRole.MASTER else "/reseller/"
    response = RedirectResponse(url=redirect_url, status_code=303)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        max_age=86400,  # 24 hours
        samesite="lax"
    )
    
    return response


@router.get("/logout")
async def logout(response: Response):
    """Logout user."""
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(key="session")
    return response


@router.get("/register", response_class=HTMLResponse)
async def register_page(request: Request, user: User = Depends(get_current_user_optional)):
    """Show registration page for new resellers."""
    if user:
        if user.role == UserRole.MASTER:
            return RedirectResponse(url="/master/", status_code=303)
        return RedirectResponse(url="/reseller/", status_code=303)
    
    return templates.TemplateResponse("auth/register.html", {
        "request": request,
        "error": None
    })


@router.post("/register")
async def register(
    request: Request,
    username: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
    name: str = Form(None),
    phone: str = Form(None),
    db: Session = Depends(get_db)
):
    """Process reseller registration."""
    # Validate passwords match
    if password != password_confirm:
        return templates.TemplateResponse("auth/register.html", {
            "request": request,
            "error": "As senhas não conferem"
        })
    
    # Check if username exists
    if db.query(User).filter(User.username == username).first():
        return templates.TemplateResponse("auth/register.html", {
            "request": request,
            "error": "Nome de usuário já existe"
        })
    
    # Check if email exists
    if db.query(User).filter(User.email == email).first():
        return templates.TemplateResponse("auth/register.html", {
            "request": request,
            "error": "Email já cadastrado"
        })
    
    # Create user
    user = User(
        username=username,
        email=email,
        password_hash=get_password_hash(password),
        role=UserRole.RESELLER,
        name=name,
        phone=phone,
        credits=0
    )
    db.add(user)
    db.commit()
    
    # Log in automatically
    token = create_access_token({"sub": str(user.id)})
    response = RedirectResponse(url="/reseller/", status_code=303)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        max_age=86400,
        samesite="lax"
    )
    
    return response


@router.get("/", response_class=HTMLResponse)
async def home(request: Request, user: User = Depends(get_current_user_optional)):
    """Home page - redirect to appropriate dashboard or login."""
    if user:
        if user.role == UserRole.MASTER:
            return RedirectResponse(url="/master/", status_code=303)
        return RedirectResponse(url="/reseller/", status_code=303)
    
    return RedirectResponse(url="/login", status_code=303)
