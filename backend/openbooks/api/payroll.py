"""Employees, timesheets and payroll.

Payroll here uses the withholding percentages entered on each employee and the
payroll tax rates in Settings. It does not contain government tax tables;
the person running payroll is responsible for entering correct rates.
"""
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from flask import jsonify, request

from ..ledger import delete_entry, post_entry, raw_balances, system_account
from ..models import (
    BANK_SUBTYPES,
    PAY_SCHEDULES,
    Account,
    Contact,
    Employee,
    Item,
    Paycheck,
    PayrollRun,
    TimeEntry,
    db,
    money,
)
from ..util import ApiError, body, get_or_404, opt_str, parse_date, required_str, to_cents
from . import bp


def _cents(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _pct(data, key, label):
    try:
        value = float(data.get(key) or 0)
    except (TypeError, ValueError):
        raise ApiError(f"{label} must be a number")
    if not 0 <= value <= 100:
        raise ApiError(f"{label} must be between 0 and 100")
    return value


# ---------------------------------------------------------------- employees


def _apply_employee(emp, data):
    emp.name = required_str(data, "name")
    for f in ("email", "phone", "address", "job_title", "other_deduction_label"):
        if f in data:
            setattr(emp, f, opt_str(data, f))
    emp.hire_date = parse_date(data.get("hire_date"), "hire date", required=False)
    pay_type = data.get("pay_type") or "hourly"
    if pay_type not in ("hourly", "salary"):
        raise ApiError("Pay type must be hourly or salary")
    schedule = data.get("pay_schedule") or "biweekly"
    if schedule not in PAY_SCHEDULES:
        raise ApiError("Invalid pay schedule")
    emp.pay_type = pay_type
    emp.pay_schedule = schedule
    emp.pay_rate_cents = to_cents(data.get("pay_rate"), "pay rate")
    emp.federal_withholding_pct = _pct(data, "federal_withholding_pct", "Federal withholding")
    emp.state_withholding_pct = _pct(data, "state_withholding_pct", "State withholding")
    emp.other_deduction_cents = to_cents(data.get("other_deduction"), "deduction")
    if "active" in data:
        emp.active = bool(data["active"])
    from ..payroll_tax import FILING_STATUSES

    if "withholding_method" in data:
        if data["withholding_method"] not in ("percent", "tables"):
            raise ApiError("Withholding method must be percent or tables")
        emp.withholding_method = data["withholding_method"]
    for key in ("w4_filing_status", "state_filing_status"):
        if key in data:
            if data[key] not in FILING_STATUSES:
                raise ApiError("Filing status must be single, married filing jointly or head of household")
            setattr(emp, key, data[key])
    if "w4_multiple_jobs" in data:
        emp.w4_multiple_jobs = bool(data["w4_multiple_jobs"])
    for key in ("w4_dependents", "w4_other_income", "w4_deductions", "w4_extra", "state_extra"):
        if key in data:
            setattr(emp, f"{key}_cents", to_cents(data.get(key), key.replace("_", " ")))
    if "work_state" in data:
        st = opt_str(data, "work_state").upper()
        if st and (len(st) != 2 or not st.isalpha()):
            raise ApiError("Work state must be a 2-letter code such as CA or TX")
        emp.work_state = st
    if "state_allowances" in data:
        try:
            emp.state_allowances = max(0, int(data.get("state_allowances") or 0))
        except (TypeError, ValueError):
            raise ApiError("State allowances must be a whole number")


@bp.get("/employees")
def list_employees():
    q = Employee.query
    if request.args.get("include_inactive") != "1":
        q = q.filter_by(active=True)
    return jsonify([e.to_dict() for e in q.order_by(Employee.name).all()])


@bp.get("/employees/<int:emp_id>")
def get_employee(emp_id):
    emp = get_or_404(Employee, emp_id, "Employee")
    d = emp.to_dict()
    year_start = date(date.today().year, 1, 1)
    checks = (
        Paycheck.query.join(PayrollRun)
        .filter(Paycheck.employee_id == emp.id, PayrollRun.pay_date >= year_start)
        .all()
    )
    d["ytd_gross"] = money(sum(p.gross_cents for p in checks))
    d["ytd_net"] = money(sum(p.net_cents for p in checks))
    d["paychecks"] = [
        {**p.to_dict(), "pay_date": p.run.pay_date.isoformat()}
        for p in Paycheck.query.join(PayrollRun).filter(Paycheck.employee_id == emp.id).order_by(PayrollRun.pay_date.desc()).all()
    ]
    return jsonify(d)


@bp.post("/employees")
def create_employee():
    data = body()
    # New employees use the tax tables, unless fixed percentages were given without choosing a method
    from .taxes import payroll_default_method

    gave_percentages = any(float(data.get(k) or 0) for k in ("federal_withholding_pct", "state_withholding_pct"))
    emp = Employee(withholding_method="percent" if gave_percentages else payroll_default_method())
    _apply_employee(emp, data)
    db.session.add(emp)
    db.session.commit()
    return jsonify(emp.to_dict()), 201


@bp.put("/employees/<int:emp_id>")
def update_employee(emp_id):
    emp = get_or_404(Employee, emp_id, "Employee")
    _apply_employee(emp, body())
    db.session.commit()
    return jsonify(emp.to_dict())


@bp.delete("/employees/<int:emp_id>")
def delete_employee(emp_id):
    emp = get_or_404(Employee, emp_id, "Employee")
    if Paycheck.query.filter_by(employee_id=emp.id).first() or TimeEntry.query.filter_by(employee_id=emp.id).first():
        raise ApiError("This employee has time or paychecks. Make them inactive instead.")
    db.session.delete(emp)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- time tracking


@bp.get("/time")
def list_time():
    q = TimeEntry.query
    if request.args.get("employee_id"):
        q = q.filter_by(employee_id=int(request.args["employee_id"]))
    if request.args.get("customer_id"):
        q = q.filter_by(customer_id=int(request.args["customer_id"]))
    start = parse_date(request.args.get("start"), "start", required=False)
    end = parse_date(request.args.get("end"), "end", required=False)
    if start:
        q = q.filter(TimeEntry.date >= start)
    if end:
        q = q.filter(TimeEntry.date <= end)
    if request.args.get("unbilled") == "1":
        q = q.filter(TimeEntry.billable.is_(True), TimeEntry.invoice_id.is_(None))
    entries = q.order_by(TimeEntry.date.desc(), TimeEntry.id).all()
    return jsonify([t.to_dict() for t in entries])


@bp.put("/time/week")
def save_week():
    """Replace one employee's editable time for a 7-day week with the rows given.

    rows: [{customer_id, item_id, billable, description, hours: [7 numbers]}]
    Entries already billed on an invoice or paid on a paycheck are kept as-is.
    """
    data = body()
    emp = get_or_404(Employee, data.get("employee_id"), "Employee")
    week_start = parse_date(data.get("week_start"), "week start")
    days = [week_start + timedelta(days=i) for i in range(7)]
    q = TimeEntry.query.filter(TimeEntry.employee_id == emp.id, TimeEntry.date >= days[0], TimeEntry.date <= days[-1])
    for t in q.all():
        if not t.locked:
            db.session.delete(t)
    db.session.flush()
    for row in data.get("rows") or []:
        hours = row.get("hours") or []
        if len(hours) != 7:
            raise ApiError("Each timesheet row needs 7 days of hours")
        customer = None
        if row.get("customer_id"):
            customer = db.session.get(Contact, row["customer_id"])
            if customer is None or customer.kind != "customer":
                raise ApiError("Customer not found")
        item = db.session.get(Item, row["item_id"]) if row.get("item_id") else None
        billable = bool(row.get("billable")) and customer is not None
        if billable and item is None:
            raise ApiError("Billable time needs a service so it can be invoiced")
        for day, h in zip(days, hours):
            try:
                h = float(h or 0)
            except (TypeError, ValueError):
                raise ApiError(f"'{h}' is not a valid number of hours")
            if h < 0 or h > 24:
                raise ApiError("Hours per day must be between 0 and 24")
            if h == 0:
                continue
            db.session.add(
                TimeEntry(
                    employee_id=emp.id,
                    date=day,
                    hours=h,
                    customer_id=customer.id if customer else None,
                    item_id=item.id if item else None,
                    billable=billable,
                    description=opt_str(row, "description"),
                )
            )
    db.session.commit()
    entries = TimeEntry.query.filter(TimeEntry.employee_id == emp.id, TimeEntry.date >= days[0], TimeEntry.date <= days[-1]).all()
    return jsonify([t.to_dict() for t in entries])


@bp.delete("/time/<int:time_id>")
def delete_time(time_id):
    t = get_or_404(TimeEntry, time_id, "Time entry")
    if t.locked:
        raise ApiError("This time has already been invoiced or paid")
    db.session.delete(t)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- payroll


def _settings():
    from .settings import get_settings

    return get_settings()


def _ytd_gross(emp_id, pay_date, exclude_run=None):
    q = Paycheck.query.join(PayrollRun).filter(
        Paycheck.employee_id == emp_id,
        PayrollRun.pay_date >= date(pay_date.year, 1, 1),
        PayrollRun.pay_date <= pay_date,
    )
    if exclude_run:
        q = q.filter(PayrollRun.id != exclude_run)
    return sum(p.gross_cents for p in q.all())


def _unpaid_hours(emp_id, start, end):
    entries = TimeEntry.query.filter(
        TimeEntry.employee_id == emp_id,
        TimeEntry.paycheck_id.is_(None),
        TimeEntry.date >= start,
        TimeEntry.date <= end,
    ).all()
    return sum(t.hours for t in entries), entries


def compute_paychecks(data):
    s = _settings()
    ss_rate = Decimal(s.get("payroll_ss_rate") or 0) / 100
    medicare_rate = Decimal(s.get("payroll_medicare_rate") or 0) / 100
    extra_rate = Decimal(s.get("payroll_employer_extra_rate") or 0) / 100
    wage_base = to_cents(s.get("payroll_ss_wage_base") or 0, "wage base")
    start = parse_date(data.get("period_start"), "period start")
    end = parse_date(data.get("period_end"), "period end")
    pay_date = parse_date(data.get("pay_date"), "pay date")
    if end < start:
        raise ApiError("The pay period ends before it starts")

    results = []
    used_tables = {}
    for row in data.get("employees") or []:
        emp = get_or_404(Employee, row.get("employee_id"), "Employee")
        tracked_hours, entries = _unpaid_hours(emp.id, start, end)
        if emp.pay_type == "hourly":
            hours = float(row["hours"]) if row.get("hours") not in (None, "") else tracked_hours
            if hours < 0:
                raise ApiError("Hours cannot be negative")
            gross = _cents(Decimal(str(hours)) * emp.pay_rate_cents)
        else:
            hours = float(row["hours"]) if row.get("hours") not in (None, "") else tracked_hours
            gross = _cents(Decimal(emp.pay_rate_cents) / PAY_SCHEDULES[emp.pay_schedule])
        if row.get("gross") not in (None, ""):
            gross = to_cents(row["gross"], "gross pay")
        if gross <= 0:
            continue
        ytd = _ytd_gross(emp.id, pay_date)
        other = emp.other_deduction_cents
        parts = {"addl_medicare": 0, "employer_ss": 0, "employer_medicare": 0, "futa": 0, "suta": 0}
        if emp.withholding_method == "tables":
            calc = _table_paycheck(emp, gross, pay_date, ytd, used_tables)
            ss, medicare, federal, state = calc["ss"], calc["medicare"], calc["federal"], calc["state"]
            parts = {k: calc[k] for k in parts}
            employer = parts["employer_ss"] + parts["employer_medicare"] + parts["futa"] + parts["suta"]
        else:
            ss_taxable = max(0, min(gross, wage_base - ytd)) if wage_base else gross
            ss = _cents(ss_taxable * ss_rate)
            medicare = _cents(gross * medicare_rate)
            federal = _cents(gross * Decimal(str(emp.federal_withholding_pct)) / 100)
            state = _cents(gross * Decimal(str(emp.state_withholding_pct)) / 100)
            parts["employer_ss"], parts["employer_medicare"] = ss, medicare
            employer = ss + medicare + _cents(gross * extra_rate)
        net = gross - ss - medicare - parts["addl_medicare"] - federal - state - other
        if net < 0:
            raise ApiError(f"{emp.name}'s deductions are larger than their gross pay")
        results.append(
            {
                "employee": emp,
                "entries": entries,
                "hours": round(hours, 2),
                "gross": gross,
                "ss": ss,
                "medicare": medicare,
                "federal": federal,
                "state": state,
                "other": other,
                "employer": employer,
                "net": net,
                "method": emp.withholding_method,
                **parts,
                "check_number": opt_str(row, "check_number"),
            }
        )
    if not results:
        raise ApiError("Include at least one employee with pay greater than zero")
    data["_tables_used"] = sorted(used_tables.values(), key=lambda t: (t["jurisdiction"], t["kind"]))
    return start, end, pay_date, results


def _table(year, jurisdiction, kind, used):
    from ..models import PayrollTaxTable

    t = PayrollTaxTable.query.filter_by(tax_year=year, jurisdiction=jurisdiction, kind=kind).first()
    if t is not None:
        used[t.id] = {"id": t.id, "name": t.name, "jurisdiction": t.jurisdiction, "kind": t.kind, "tax_year": t.tax_year, "verified": t.verified}
    return t


def _table_paycheck(emp, gross, pay_date, ytd, used):
    """Withholding and employer taxes for one paycheck from the tax tables for the pay date's year."""
    from ..payroll_tax import federal_withholding, fica, state_withholding, unemployment

    year = pay_date.year
    periods = PAY_SCHEDULES[emp.pay_schedule]
    fed = _table(year, "US-FED", "income_tax", used)
    if fed is None:
        raise ApiError(f"There are no federal tax tables for {year}. Add them under Taxes → Payroll tax, or switch {emp.name} to fixed percentages.")
    ss_t = _table(year, "US-FED", "social_security", used)
    med_t = _table(year, "US-FED", "medicare", used)
    futa_t = _table(year, "US-FED", "futa", used)
    federal = federal_withholding(
        fed.values(),
        wages_cents=gross,
        periods=periods,
        filing_status=emp.w4_filing_status,
        multiple_jobs=emp.w4_multiple_jobs,
        dependents_cents=emp.w4_dependents_cents,
        other_income_cents=emp.w4_other_income_cents,
        deductions_cents=emp.w4_deductions_cents,
        extra_cents=emp.w4_extra_cents,
    )
    state = 0
    suta = 0
    if emp.work_state:
        jur = f"US-{emp.work_state.upper()}"
        st = _table(year, jur, "income_tax", used)
        if st is None:
            raise ApiError(f"There is no {emp.work_state.upper()} income tax table for {year}. Add one under Taxes → Payroll tax (use 'no income tax' if the state has none).")
        state = state_withholding(st.values(), wages_cents=gross, periods=periods, filing_status=emp.state_filing_status, allowances=emp.state_allowances, extra_cents=emp.state_extra_cents)
        suta_t = _table(year, jur, "suta", used)
        suta = unemployment(suta_t.values() if suta_t else None, wages_cents=gross, ytd_wages_cents=ytd)
    f = fica(ss_t.values() if ss_t else None, med_t.values() if med_t else None, wages_cents=gross, ytd_wages_cents=ytd)
    return {
        "federal": federal,
        "state": state,
        "ss": f["ss_employee"],
        "medicare": f["medicare_employee"],
        "addl_medicare": f["addl_medicare"],
        "employer_ss": f["ss_employer"],
        "employer_medicare": f["medicare_employer"],
        "futa": unemployment(futa_t.values() if futa_t else None, wages_cents=gross, ytd_wages_cents=ytd),
        "suta": suta,
    }


def _paycheck_preview(r):
    return {
        "employee_id": r["employee"].id,
        "employee": r["employee"].name,
        "pay_type": r["employee"].pay_type,
        "hours": r["hours"],
        "gross": money(r["gross"]),
        "social_security": money(r["ss"]),
        "medicare": money(r["medicare"]),
        "federal_withholding": money(r["federal"]),
        "state_withholding": money(r["state"]),
        "other_deduction": money(r["other"]),
        "employee_taxes": money(r["ss"] + r["medicare"] + r["addl_medicare"] + r["federal"] + r["state"]),
        "additional_medicare": money(r["addl_medicare"]),
        "futa": money(r["futa"]),
        "suta": money(r["suta"]),
        "method": r["method"],
        "employer_taxes": money(r["employer"]),
        "net": money(r["net"]),
    }


@bp.get("/payroll/prefill")
def payroll_prefill():
    """Suggested hours for every active employee for a pay period."""
    start = parse_date(request.args.get("period_start"), "period start")
    end = parse_date(request.args.get("period_end"), "period end")
    rows = []
    for emp in Employee.query.filter_by(active=True).order_by(Employee.name).all():
        hours, _ = _unpaid_hours(emp.id, start, end)
        rows.append({**emp.to_dict(), "tracked_hours": round(hours, 2)})
    return jsonify(rows)


@bp.post("/payroll/preview")
def payroll_preview():
    data = body()
    _, _, _, results = compute_paychecks(data)
    return jsonify(
        {
            "tables_used": data.get("_tables_used", []),
            "unverified_tables": [t for t in data.get("_tables_used", []) if not t["verified"]],
            "paychecks": [_paycheck_preview(r) for r in results],
            "totals": {
                "gross": money(sum(r["gross"] for r in results)),
                "net": money(sum(r["net"] for r in results)),
                "employee_taxes": money(sum(r["ss"] + r["medicare"] + r["addl_medicare"] + r["federal"] + r["state"] for r in results)),
                "employer_taxes": money(sum(r["employer"] for r in results)),
                "total_cost": money(sum(r["gross"] + r["employer"] for r in results)),
            },
        }
    )


@bp.get("/payroll/runs")
def list_payroll_runs():
    return jsonify([r.to_dict() for r in PayrollRun.query.order_by(PayrollRun.pay_date.desc(), PayrollRun.id.desc()).all()])


@bp.get("/payroll/runs/<int:run_id>")
def get_payroll_run(run_id):
    return jsonify(get_or_404(PayrollRun, run_id, "Payroll").to_dict(full=True))


@bp.post("/payroll/runs")
def create_payroll_run():
    run = run_payroll(body())
    db.session.commit()
    return jsonify(run.to_dict(full=True)), 201


def run_payroll(data):
    account = db.session.get(Account, data.get("account_id"))
    if account is None or account.subtype not in ("bank", "cash"):
        raise ApiError("Choose the bank account paychecks are paid from")
    start, end, pay_date, results = compute_paychecks(data)
    unverified = [t["name"] for t in data.get("_tables_used", []) if not t["verified"]]
    if unverified and not data.get("acknowledge_unverified"):
        raise ApiError(
            "These tax tables have not been verified by an administrator: " + ", ".join(unverified)
            + ". Check them under Taxes → Payroll tax, or confirm you want to run payroll anyway."
        )
    run = PayrollRun(period_start=start, period_end=end, pay_date=pay_date, account_id=account.id)
    db.session.add(run)
    db.session.flush()
    for r in results:
        check = Paycheck(
            run_id=run.id,
            employee_id=r["employee"].id,
            hours=r["hours"],
            gross_cents=r["gross"],
            ss_cents=r["ss"],
            medicare_cents=r["medicare"],
            federal_cents=r["federal"],
            state_cents=r["state"],
            other_deduction_cents=r["other"],
            employer_tax_cents=r["employer"],
            net_cents=r["net"],
            check_number=r["check_number"],
            method=r["method"],
            addl_medicare_cents=r["addl_medicare"],
            employer_ss_cents=r["employer_ss"],
            employer_medicare_cents=r["employer_medicare"],
            futa_cents=r["futa"],
            suta_cents=r["suta"],
        )
        db.session.add(check)
        db.session.flush()
        for t in r["entries"]:
            t.paycheck_id = check.id

    gross = sum(r["gross"] for r in results)
    employer = sum(r["employer"] for r in results)
    net = sum(r["net"] for r in results)
    lines = [
        {"account_id": system_account("payroll_expense").id, "debit": gross, "description": "Gross wages"},
        {"account_id": account.id, "credit": net, "description": "Net pay"},
        {"account_id": system_account("payroll_liability").id, "credit": gross - net + employer, "description": "Withholdings and employer taxes"},
    ]
    if employer:
        lines.insert(1, {"account_id": system_account("payroll_tax_expense").id, "debit": employer, "description": "Employer payroll taxes"})
    entry = post_entry(
        date=pay_date,
        memo=f"Payroll {start.isoformat()} – {end.isoformat()} ({len(results)} employee{'s' if len(results) != 1 else ''})",
        source_type="payroll",
        source_id=run.id,
        lines=lines,
    )
    run.journal_entry_id = entry.id
    db.session.flush()
    return run


@bp.delete("/payroll/runs/<int:run_id>")
def delete_payroll_run(run_id):
    run = get_or_404(PayrollRun, run_id, "Payroll")
    delete_entry(run.journal_entry_id)
    for check in run.paychecks:
        TimeEntry.query.filter_by(paycheck_id=check.id).update({"paycheck_id": None})
    db.session.delete(run)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/payroll/liabilities")
def payroll_liabilities():
    account = system_account("payroll_liability")
    raw = raw_balances().get(account.id, 0)
    return jsonify({"account_id": account.id, "account": account.label, "balance": money(-raw)})


@bp.post("/payroll/liabilities/pay")
def pay_payroll_liabilities():
    data = body()
    bank = db.session.get(Account, data.get("account_id"))
    if bank is None or bank.subtype not in BANK_SUBTYPES:
        raise ApiError("Choose the account the payment was made from")
    amount = to_cents(data.get("amount"), "amount", allow_zero=False)
    liability = system_account("payroll_liability")
    owed = -raw_balances().get(liability.id, 0)
    if amount > owed:
        raise ApiError(f"That is more than the payroll liabilities owed ({owed / 100:.2f})")
    entry = post_entry(
        date=parse_date(data.get("date")),
        memo=opt_str(data, "memo") or "Payroll tax payment",
        reference=opt_str(data, "reference"),
        source_type="payroll_tax_payment",
        lines=[
            {"account_id": liability.id, "debit": amount},
            {"account_id": bank.id, "credit": amount},
        ],
    )
    db.session.commit()
    return jsonify(entry.to_dict()), 201
