"""Payroll tax tables (editable, verifiable) and the payroll tax liability report."""
import json
from datetime import date, datetime, timezone

from flask import g, jsonify, request
from sqlalchemy import func

from ..models import Paycheck, PayrollRun, PayrollTaxTable, db, money
from ..payroll_tax import FILING_STATUSES
from ..util import ApiError, arg_date, body, get_or_404, opt_str
from . import bp, require_admin

KINDS = ("income_tax", "social_security", "medicare", "futa", "suta")


def _num(value, label, low=0.0, high=None):
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ApiError(f"{label} must be a number")
    if n < low or (high is not None and n > high):
        raise ApiError(f"{label} is out of range")
    return n


def _validate(kind, jurisdiction, data):
    """Check a table's data has the shape the engine expects."""
    if not isinstance(data, dict):
        raise ApiError("Table data must be an object")
    if kind == "income_tax":
        method = data.get("method")
        if jurisdiction == "US-FED" and method != "w4_2020":
            raise ApiError("The federal income tax table must use the W-4 (2020+) method")
        if method == "w4_2020" or method == "brackets":
            rates = data.get("rates") or []
            if not rates:
                raise ApiError("Add the tax rates")
            for r in rates:
                _num(r, "Each rate", 0, 100)
            brackets = data.get("brackets") or {}
            for status in FILING_STATUSES if method == "w4_2020" else brackets.keys():
                limits = brackets.get(status)
                if not isinstance(limits, list) or len(limits) != len(rates) - 1:
                    raise ApiError(f"Brackets for {status.replace('_', ' ')} need {len(rates) - 1} upper limits (one fewer than the rates)")
                if any(_num(b, "Bracket limit") <= _num(a, "Bracket limit") for a, b in zip(limits, limits[1:])):
                    raise ApiError(f"Bracket limits for {status.replace('_', ' ')} must increase")
            sd = data.get("standard_deduction", {})
            if method == "w4_2020":
                for status in FILING_STATUSES:
                    _num(sd.get(status), f"Standard deduction ({status.replace('_', ' ')})")
        elif method == "flat":
            _num(data.get("rate"), "Rate", 0, 100)
        elif method != "none":
            raise ApiError("State income tax method must be none, flat or brackets")
    elif kind in ("social_security", "futa", "suta"):
        _num(data.get("rate"), "Rate", 0, 100)
        _num(data.get("wage_base", 0), "Wage base")
    elif kind == "medicare":
        _num(data.get("rate"), "Rate", 0, 100)
        _num(data.get("additional_rate", 0), "Additional Medicare rate", 0, 100)
        _num(data.get("additional_threshold", 0), "Additional Medicare threshold")
    return data


@bp.get("/payroll-tax/tables")
def list_tax_tables():
    q = PayrollTaxTable.query
    if request.args.get("year"):
        q = q.filter_by(tax_year=int(request.args["year"]))
    tables = q.order_by(PayrollTaxTable.tax_year.desc(), PayrollTaxTable.jurisdiction, PayrollTaxTable.kind).all()
    years = sorted({t.tax_year for t in PayrollTaxTable.query.all()}, reverse=True)
    return jsonify({"years": years, "tables": [t.to_dict() for t in tables]})


@bp.post("/payroll-tax/tables")
def create_tax_table():
    require_admin()
    data = body()
    try:
        year = int(data.get("tax_year"))
    except (TypeError, ValueError):
        raise ApiError("Tax year is required")
    jurisdiction = opt_str(data, "jurisdiction").upper()
    if not (jurisdiction == "US-FED" or (jurisdiction.startswith("US-") and len(jurisdiction) == 5)):
        raise ApiError("Jurisdiction must be US-FED or US- plus a 2-letter state code, e.g. US-CA")
    kind = data.get("kind")
    if kind not in KINDS:
        raise ApiError("Unknown table kind")
    if PayrollTaxTable.query.filter_by(tax_year=year, jurisdiction=jurisdiction, kind=kind).first():
        raise ApiError("A table for that year, jurisdiction and kind already exists")
    table = PayrollTaxTable(
        tax_year=year,
        jurisdiction=jurisdiction,
        kind=kind,
        name=opt_str(data, "name") or f"{jurisdiction} {kind.replace('_', ' ')} {year}",
        data=json.dumps(_validate(kind, jurisdiction, data.get("data") or {})),
        source=opt_str(data, "source"),
    )
    db.session.add(table)
    db.session.commit()
    return jsonify(table.to_dict()), 201


@bp.put("/payroll-tax/tables/<int:table_id>")
def update_tax_table(table_id):
    require_admin()
    table = get_or_404(PayrollTaxTable, table_id, "Tax table")
    data = body()
    if "data" in data:
        table.data = json.dumps(_validate(table.kind, table.jurisdiction, data["data"]))
        # any change to the figures needs re-verifying
        table.verified = False
        table.verified_by = ""
        table.verified_at = None
    if "name" in data:
        table.name = opt_str(data, "name") or table.name
    if "source" in data:
        table.source = opt_str(data, "source")
    db.session.commit()
    return jsonify(table.to_dict())


@bp.post("/payroll-tax/tables/<int:table_id>/verify")
def verify_tax_table(table_id):
    require_admin()
    table = get_or_404(PayrollTaxTable, table_id, "Tax table")
    verified = bool(body().get("verified", True))
    table.verified = verified
    table.verified_by = (g.user.name or g.user.email) if verified else ""
    table.verified_at = datetime.now(timezone.utc).replace(tzinfo=None) if verified else None
    db.session.commit()
    return jsonify(table.to_dict())


@bp.delete("/payroll-tax/tables/<int:table_id>")
def delete_tax_table(table_id):
    require_admin()
    table = get_or_404(PayrollTaxTable, table_id, "Tax table")
    db.session.delete(table)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/payroll-tax/tables/copy-year")
def copy_tax_year():
    """Start a new tax year from the previous year's tables (unverified, to be updated)."""
    require_admin()
    data = body()
    try:
        source, target = int(data.get("from_year")), int(data.get("to_year"))
    except (TypeError, ValueError):
        raise ApiError("Choose the years to copy from and to")
    created = 0
    for t in PayrollTaxTable.query.filter_by(tax_year=source).all():
        if PayrollTaxTable.query.filter_by(tax_year=target, jurisdiction=t.jurisdiction, kind=t.kind).first():
            continue
        db.session.add(
            PayrollTaxTable(
                tax_year=target,
                jurisdiction=t.jurisdiction,
                kind=t.kind,
                name=t.name.replace(str(source), str(target)),
                data=t.data,
                source=f"Copied from {source}; update for {target}",
            )
        )
        created += 1
    db.session.commit()
    return jsonify({"created": created})


@bp.get("/payroll-tax/liability")
def payroll_tax_liability():
    """Payroll taxes withheld and owed by the employer, by tax, for paychecks dated in a range."""
    end = arg_date("end", date.today())
    start = arg_date("start", date(end.year, 1, 1))
    cols = {
        "federal_income_tax": Paycheck.federal_cents,
        "state_income_tax": Paycheck.state_cents,
        "social_security_employee": Paycheck.ss_cents,
        "social_security_employer": Paycheck.employer_ss_cents,
        "medicare_employee": Paycheck.medicare_cents,
        "medicare_employer": Paycheck.employer_medicare_cents,
        "additional_medicare": Paycheck.addl_medicare_cents,
        "futa": Paycheck.futa_cents,
        "suta": Paycheck.suta_cents,
        "other_deductions": Paycheck.other_deduction_cents,
        "gross_wages": Paycheck.gross_cents,
        "net_pay": Paycheck.net_cents,
        "employer_total": Paycheck.employer_tax_cents,
    }
    row = (
        db.session.query(*[func.coalesce(func.sum(c), 0) for c in cols.values()], func.count(Paycheck.id))
        .join(PayrollRun, Paycheck.run_id == PayrollRun.id)
        .filter(PayrollRun.pay_date >= start, PayrollRun.pay_date <= end)
        .one()
    )
    totals = {k: int(v) for k, v in zip(cols.keys(), row[:-1])}
    # Older (fixed-percentage) paychecks only stored the employer total; attribute it to FICA match
    other_employer = totals["employer_total"] - totals["social_security_employer"] - totals["medicare_employer"] - totals["futa"] - totals["suta"]
    lines = [
        ("Federal income tax withheld", "employee", totals["federal_income_tax"]),
        ("State income tax withheld", "employee", totals["state_income_tax"]),
        ("Social security – employee", "employee", totals["social_security_employee"]),
        ("Social security – employer", "employer", totals["social_security_employer"]),
        ("Medicare – employee", "employee", totals["medicare_employee"]),
        ("Medicare – employer", "employer", totals["medicare_employer"]),
        ("Additional Medicare – employee", "employee", totals["additional_medicare"]),
        ("Federal unemployment (FUTA)", "employer", totals["futa"]),
        ("State unemployment (SUTA)", "employer", totals["suta"]),
    ]
    if other_employer:
        lines.append(("Other employer payroll taxes", "employer", other_employer))
    return jsonify(
        {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "paychecks": int(row[-1]),
            "gross_wages": money(totals["gross_wages"]),
            "net_pay": money(totals["net_pay"]),
            "other_deductions": money(totals["other_deductions"]),
            "lines": [{"name": n, "paid_by": who, "amount": money(a)} for n, who, a in lines if a],
            "total_employee": money(sum(a for _, who, a in lines if who == "employee")),
            "total_employer": money(sum(a for _, who, a in lines if who == "employer")),
            "total": money(sum(a for _, _, a in lines)),
        }
    )
