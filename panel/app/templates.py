"""Template configuration."""
import os
from fastapi.templating import Jinja2Templates

# Get the directory where templates are stored
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")

# Initialize Jinja2 templates
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# Add custom filters
def format_datetime(value):
    """Format datetime for display."""
    if not value:
        return "-"
    return value.strftime("%d/%m/%Y %H:%M")

def format_date(value):
    """Format date for display."""
    if not value:
        return "-"
    return value.strftime("%d/%m/%Y")

def format_credits(value):
    """Format credits with 2 decimal places."""
    if value is None:
        return "0.00"
    return f"{value:.2f}"

def format_currency(value):
    """Format currency (BRL)."""
    if value is None:
        return "R$ 0,00"
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

def status_badge(status):
    """Return Bootstrap badge class for status."""
    badges = {
        "trial": "bg-info",
        "active": "bg-success",
        "expired": "bg-warning text-dark",
        "blocked": "bg-danger",
        "pending": "bg-secondary",
        "paid": "bg-success"
    }
    return badges.get(str(status), "bg-secondary")

def status_label(status):
    """Return Portuguese label for status."""
    labels = {
        "trial": "Teste",
        "active": "Ativo",
        "expired": "Expirado",
        "blocked": "Bloqueado",
        "pending": "Pendente",
        "paid": "Pago"
    }
    return labels.get(str(status), status)

def transaction_badge(tx_type):
    """Return badge class for transaction type."""
    badges = {
        "purchase": "bg-success",
        "activation": "bg-primary",
        "renewal": "bg-info",
        "bonus": "bg-warning text-dark",
        "refund": "bg-danger"
    }
    return badges.get(str(tx_type), "bg-secondary")

def transaction_label(tx_type):
    """Return Portuguese label for transaction type."""
    labels = {
        "purchase": "Compra",
        "activation": "Ativação",
        "renewal": "Renovação",
        "bonus": "Bônus",
        "refund": "Estorno"
    }
    return labels.get(str(tx_type), tx_type)

# Register filters
templates.env.filters["datetime"] = format_datetime
templates.env.filters["date"] = format_date
templates.env.filters["credits"] = format_credits
templates.env.filters["currency"] = format_currency
templates.env.filters["status_badge"] = status_badge
templates.env.filters["status_label"] = status_label
templates.env.filters["tx_badge"] = transaction_badge
templates.env.filters["tx_label"] = transaction_label
