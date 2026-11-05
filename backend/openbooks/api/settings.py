from flask import jsonify

from ..models import Setting, db
from ..seed import DEFAULT_SETTINGS, books_empty, erase_books, load_demo_data, remove_sample_data, sample_data_status
from ..util import ApiError, body
from . import bp, require_admin


def get_settings():
    """Company settings. Only known, non-secret keys are returned (Stripe keys are never included)."""
    values = dict(DEFAULT_SETTINGS)
    values.update({s.key: s.value for s in Setting.query.filter(Setting.key.in_(DEFAULT_SETTINGS)).all()})
    return values


def set_setting(key, value):
    row = db.session.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        db.session.add(row)
    row.value = str(value)


@bp.get("/settings")
def read_settings():
    from .online_payments import public_config

    values = get_settings()
    values["books_empty"] = books_empty()
    values["sample_data_loaded"] = sample_data_status() is not None
    values.update(public_config())
    return jsonify(values)


@bp.put("/settings")
def update_settings():
    require_admin()
    data = body()
    for key in DEFAULT_SETTINGS:
        if key in data:
            value = str(data[key] if data[key] is not None else "").strip()
            if key == "company_name" and not value:
                raise ApiError("Company name is required")
            if key in ("default_tax_rate", "payroll_ss_rate", "payroll_medicare_rate", "payroll_employer_extra_rate", "payroll_ss_wage_base"):
                try:
                    if float(value or 0) < 0:
                        raise ValueError
                except ValueError:
                    raise ApiError(f"{key.replace('_', ' ').capitalize()} must be a positive number")
            if key in ("next_invoice_number", "next_estimate_number", "next_receipt_number", "default_terms_days", "fiscal_year_start_month"):
                if not value.isdigit():
                    raise ApiError(f"{key.replace('_', ' ').capitalize()} must be a whole number")
                if key == "fiscal_year_start_month" and not 1 <= int(value) <= 12:
                    raise ApiError("Fiscal year start month must be between 1 and 12")
            if key == "tax_provider" and value not in ("manual", "stripe_tax"):
                raise ApiError("Unknown tax provider")
            if key == "currency" and len(value) != 3:
                raise ApiError("Currency must be a 3-letter code such as USD, EUR or GBP")
            set_setting(key, value.upper() if key == "currency" else value)
    db.session.commit()
    return read_settings()


@bp.post("/settings/sample-data")
def sample_data():
    require_admin()
    if not books_empty():
        raise ApiError("Sample data can only be loaded into empty books")
    load_demo_data()
    return jsonify({"ok": True})


@bp.post("/settings/sample-data/remove")
def delete_sample_data():
    require_admin()
    remove_sample_data()
    return jsonify({"ok": True})


@bp.post("/settings/erase")
def erase_all_data():
    """Erase all transactions and lists. The admin must type ERASE to confirm."""
    require_admin()
    data = body()
    if str(data.get("confirm") or "").strip() != "ERASE":
        raise ApiError("Type ERASE to confirm")
    erase_books(include_tax_setup=bool(data.get("include_tax_setup")))
    return jsonify({"ok": True})
