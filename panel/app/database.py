"""Database configuration and models."""
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, Float, ForeignKey, Text, Enum as SQLEnum
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
import enum

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/panel.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class UserRole(str, enum.Enum):
    MASTER = "master"
    RESELLER = "reseller"


class DeviceStatus(str, enum.Enum):
    TRIAL = "trial"
    ACTIVE = "active"
    EXPIRED = "expired"
    BLOCKED = "blocked"


class TransactionType(str, enum.Enum):
    PURCHASE = "purchase"       # Revendedor comprou créditos
    ACTIVATION = "activation"   # Ativou um dispositivo
    RENEWAL = "renewal"         # Renovou um dispositivo
    BONUS = "bonus"             # Bônus dado pelo master
    REFUND = "refund"           # Estorno


class User(Base):
    """Master and reseller accounts."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    password_hash = Column(String(128), nullable=False)
    role = Column(SQLEnum(UserRole), default=UserRole.RESELLER, nullable=False)
    
    # Reseller info
    name = Column(String(100))
    phone = Column(String(20))
    credits = Column(Float, default=0.0)  # Créditos disponíveis
    
    # Status
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)
    
    # Parent (for resellers created by master)
    parent_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    parent = relationship("User", remote_side=[id], backref="resellers")
    
    # Relationships
    devices = relationship("Device", back_populates="owner")
    transactions = relationship("Transaction", back_populates="user", foreign_keys="Transaction.user_id")


class Device(Base):
    """TV devices registered in the system."""
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(10), unique=True, index=True, nullable=False)  # Ex: K7M-42Q
    mac_address = Column(String(20), index=True)  # Identificador do dispositivo
    model = Column(String(100))  # Ex: UN49KU6300
    platform = Column(String(20))  # tizen, webos, android, etc.
    
    # Xtream config (encrypted in production)
    dns = Column(String(200))
    xtream_username = Column(String(100))
    xtream_password = Column(String(100))
    
    # Status and dates
    status = Column(SQLEnum(DeviceStatus), default=DeviceStatus.TRIAL)
    trial_ends = Column(DateTime)
    expires_at = Column(DateTime)
    
    # Owner (reseller)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    owner = relationship("User", back_populates="devices")
    
    # Metadata
    notes = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime)
    app_version = Column(String(20))

    @staticmethod
    def generate_code() -> str:
        """Generate a unique device code like K7M-42Q."""
        chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # No I, O, 0, 1 to avoid confusion
        part1 = "".join(secrets.choice(chars) for _ in range(3))
        part2 = "".join(secrets.choice(chars) for _ in range(3))
        return f"{part1}-{part2}"


class Transaction(Base):
    """Credit transactions history."""
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    user = relationship("User", back_populates="transactions")
    
    type = Column(SQLEnum(TransactionType), nullable=False)
    amount = Column(Float, nullable=False)  # Positive or negative
    balance_after = Column(Float)  # Balance after transaction
    
    # Reference (device_id, payment_id, etc.)
    reference_id = Column(Integer)
    reference_type = Column(String(20))  # device, payment, etc.
    
    description = Column(String(200))
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_id = Column(Integer, ForeignKey("users.id"))


class Plan(Base):
    """Subscription plans available."""
    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False)  # Ex: "Mensal", "Anual"
    days = Column(Integer, nullable=False)  # Duration in days
    credits_cost = Column(Float, nullable=False)  # Cost in credits for resellers
    price = Column(Float)  # Suggested retail price (optional)
    is_active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)


class CreditPackage(Base):
    """Credit packages that resellers can buy."""
    __tablename__ = "credit_packages"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False)  # Ex: "100 Créditos"
    credits = Column(Float, nullable=False)
    price = Column(Float, nullable=False)  # Price in BRL
    bonus_credits = Column(Float, default=0)  # Bonus credits
    is_active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)


class Payment(Base):
    """Pix payments for credit purchases."""
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    package_id = Column(Integer, ForeignKey("credit_packages.id"))
    
    amount = Column(Float, nullable=False)  # Amount in BRL
    credits = Column(Float, nullable=False)  # Credits to add
    
    # Pix info
    pix_code = Column(String(500))  # Pix copia-e-cola
    pix_qr_code = Column(Text)  # QR code base64
    external_id = Column(String(100))  # ID from payment gateway
    
    status = Column(String(20), default="pending")  # pending, paid, expired, refunded
    paid_at = Column(DateTime)
    expires_at = Column(DateTime)
    
    created_at = Column(DateTime, default=datetime.utcnow)


class Settings(Base):
    """System settings."""
    __tablename__ = "settings"

    key = Column(String(50), primary_key=True)
    value = Column(Text)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def get_db():
    """Dependency to get database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database and create tables."""
    import os
    os.makedirs("data", exist_ok=True)
    Base.metadata.create_all(bind=engine)
