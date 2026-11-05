"""Request parsing helpers."""
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from flask import request


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Expected a JSON object in the request body")
    return data


def to_cents(value, field="amount", allow_negative=False, allow_zero=True):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        value = 0
    try:
        cleaned = str(value).replace(",", "").replace("$", "").strip()
        cents = int((Decimal(cleaned) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        raise ApiError(f"'{value}' is not a valid {field}")
    if cents < 0 and not allow_negative:
        raise ApiError(f"The {field} cannot be negative")
    if cents == 0 and not allow_zero:
        raise ApiError(f"The {field} must be greater than zero")
    return cents


def to_decimal(value, field="quantity"):
    try:
        return Decimal(str(value if value not in (None, "") else 0))
    except InvalidOperation:
        raise ApiError(f"'{value}' is not a valid {field}")


def parse_date(value, field="date", required=True):
    if value in (None, ""):
        if required:
            raise ApiError(f"The {field} is required")
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ApiError(f"'{value}' is not a valid {field} (use YYYY-MM-DD)")


def arg_date(name, default=None):
    value = request.args.get(name)
    return parse_date(value, name, required=False) or default


def required_str(data, key, label=None):
    value = str(data.get(key) or "").strip()
    if not value:
        raise ApiError(f"{label or key.replace('_', ' ').capitalize()} is required")
    return value


def opt_str(data, key):
    return str(data.get(key) or "").strip()


def get_or_404(model, obj_id, label="Record"):
    from .models import db

    obj = db.session.get(model, obj_id)
    if obj is None:
        raise ApiError(f"{label} not found", 404)
    return obj
