"""Business income tax preparation: map income/expense accounts to tax-return lines
and produce a year-end summary for the owner or their accountant.

Line references follow the IRS forms as published for recent tax years; forms are
occasionally renumbered, so the report asks users to confirm against the current
year's form. OpenBooks does not prepare or file the return itself.
"""
import json
from datetime import date

from flask import jsonify, request

from ..ledger import account_balances
from ..models import SUBTYPE_COGS, Account, Setting, db, money
from ..util import ApiError, body
from . import bp, require_admin

# key: (name, entity, [(code, label, kind, note)]); kind: income | contra | cogs | expense
FORMS = {
    "schedule_c": (
        "Schedule C (Form 1040) – Profit or Loss From Business",
        "Sole proprietor / single-member LLC",
        [
            ("1", "Gross receipts or sales", "income", ""),
            ("2", "Returns and allowances", "contra", ""),
            ("4", "Cost of goods sold", "cogs", ""),
            ("6", "Other income", "income", ""),
            ("8", "Advertising", "expense", ""),
            ("9", "Car and truck expenses", "expense", "Standard mileage or actual expenses; keep mileage records"),
            ("10", "Commissions and fees", "expense", ""),
            ("11", "Contract labor", "expense", ""),
            ("13", "Depreciation and section 179 expense", "expense", "Calculated on Form 4562; book depreciation may differ"),
            ("14", "Employee benefit programs", "expense", ""),
            ("15", "Insurance (other than health)", "expense", ""),
            ("16b", "Interest (other)", "expense", ""),
            ("17", "Legal and professional services", "expense", ""),
            ("18", "Office expense", "expense", ""),
            ("19", "Pension and profit-sharing plans", "expense", ""),
            ("20a", "Rent or lease – vehicles, machinery and equipment", "expense", ""),
            ("20b", "Rent or lease – other business property", "expense", ""),
            ("21", "Repairs and maintenance", "expense", ""),
            ("22", "Supplies", "expense", ""),
            ("23", "Taxes and licenses", "expense", ""),
            ("24a", "Travel", "expense", ""),
            ("24b", "Deductible meals", "expense", "Business meals are generally only 50% deductible"),
            ("25", "Utilities", "expense", ""),
            ("26", "Wages (less employment credits)", "expense", ""),
            ("27a", "Other expenses", "expense", "List on Part V"),
        ],
    ),
    "f1120": (
        "Form 1120 – U.S. Corporation Income Tax Return",
        "C corporation",
        [
            ("1a", "Gross receipts or sales", "income", ""),
            ("1b", "Returns and allowances", "contra", ""),
            ("2", "Cost of goods sold", "cogs", ""),
            ("5", "Interest", "income", ""),
            ("6", "Gross rents", "income", ""),
            ("10", "Other income", "income", ""),
            ("12", "Compensation of officers", "expense", ""),
            ("13", "Salaries and wages", "expense", ""),
            ("14", "Repairs and maintenance", "expense", ""),
            ("15", "Bad debts", "expense", ""),
            ("16", "Rents", "expense", ""),
            ("17", "Taxes and licenses", "expense", ""),
            ("18", "Interest expense", "expense", ""),
            ("19", "Charitable contributions", "expense", "Limited to a percentage of taxable income"),
            ("20", "Depreciation", "expense", "Calculated on Form 4562; book depreciation may differ"),
            ("22", "Advertising", "expense", ""),
            ("23", "Pension, profit-sharing, etc., plans", "expense", ""),
            ("24", "Employee benefit programs", "expense", ""),
            ("26", "Other deductions", "expense", "Attach a statement; meals are generally 50% deductible"),
        ],
    ),
    "f1120s": (
        "Form 1120-S – U.S. Income Tax Return for an S Corporation",
        "S corporation",
        [
            ("1a", "Gross receipts or sales", "income", ""),
            ("1b", "Returns and allowances", "contra", ""),
            ("2", "Cost of goods sold", "cogs", ""),
            ("5", "Other income", "income", ""),
            ("7", "Compensation of officers", "expense", ""),
            ("8", "Salaries and wages", "expense", ""),
            ("9", "Repairs and maintenance", "expense", ""),
            ("10", "Bad debts", "expense", ""),
            ("11", "Rents", "expense", ""),
            ("12", "Taxes and licenses", "expense", ""),
            ("13", "Interest", "expense", ""),
            ("14", "Depreciation", "expense", "Calculated on Form 4562; book depreciation may differ"),
            ("16", "Advertising", "expense", ""),
            ("17", "Pension, profit-sharing, etc., plans", "expense", ""),
            ("18", "Employee benefit programs", "expense", ""),
            ("20", "Other deductions", "expense", "Attach a statement; meals are generally 50% deductible"),
        ],
    ),
    "f1065": (
        "Form 1065 – U.S. Return of Partnership Income",
        "Partnership / multi-member LLC",
        [
            ("1a", "Gross receipts or sales", "income", ""),
            ("1b", "Returns and allowances", "contra", ""),
            ("2", "Cost of goods sold", "cogs", ""),
            ("7", "Other income", "income", ""),
            ("9", "Salaries and wages (other than to partners)", "expense", ""),
            ("10", "Guaranteed payments to partners", "expense", ""),
            ("11", "Repairs and maintenance", "expense", ""),
            ("12", "Bad debts", "expense", ""),
            ("13", "Rent", "expense", ""),
            ("14", "Taxes and licenses", "expense", ""),
            ("15", "Interest", "expense", ""),
            ("16a", "Depreciation", "expense", "Calculated on Form 4562; book depreciation may differ"),
            ("18", "Retirement plans, etc.", "expense", ""),
            ("19", "Employee benefit programs", "expense", ""),
            ("21", "Other deductions", "expense", "Attach a statement; meals are generally 50% deductible"),
        ],
    ),
}
CUSTOM_KEY = "custom"


def _setting(key, default=""):
    row = db.session.get(Setting, key)
    return row.value if row else default


def _set(key, value):
    row = db.session.get(Setting, key) or Setting(key=key)
    row.value = value
    db.session.add(row)


def _custom_lines():
    try:
        lines = json.loads(_setting("income_tax_custom_lines", "[]"))
    except ValueError:
        lines = []
    return [(l["code"], l["label"], l.get("kind", "expense"), l.get("note", "")) for l in lines]


def _form(key):
    if key == CUSTOM_KEY:
        return ("Custom tax categories", "Define your own lines (e.g. for a non-US return)", _custom_lines())
    if key not in FORMS:
        raise ApiError("Choose a tax return type first")
    return FORMS[key]


def _mappings(form_key):
    try:
        all_maps = json.loads(_setting("income_tax_mappings", "{}"))
    except ValueError:
        all_maps = {}
    return {int(k): v for k, v in all_maps.get(form_key, {}).items()}


def _save_mappings(form_key, mapping):
    try:
        all_maps = json.loads(_setting("income_tax_mappings", "{}"))
    except ValueError:
        all_maps = {}
    all_maps[form_key] = {str(k): v for k, v in mapping.items() if v}
    _set("income_tax_mappings", json.dumps(all_maps))


KEYWORDS = [
    (("advertis", "marketing"), {"schedule_c": "8", "f1120": "22", "f1120s": "16", "f1065": "21"}),
    (("vehicle", "car ", "truck", "fuel", "mileage"), {"schedule_c": "9"}),
    (("commission",), {"schedule_c": "10"}),
    (("contract labor", "contractor", "freelanc"), {"schedule_c": "11"}),
    (("depreciation",), {"schedule_c": "13", "f1120": "20", "f1120s": "14", "f1065": "16a"}),
    (("insurance",), {"schedule_c": "15"}),
    (("interest",), {"schedule_c": "16b", "f1120": "18", "f1120s": "13", "f1065": "15"}),
    (("legal", "professional", "accounting", "bookkeep"), {"schedule_c": "17"}),
    (("office",), {"schedule_c": "18"}),
    (("rent", "lease"), {"schedule_c": "20b", "f1120": "16", "f1120s": "11", "f1065": "13"}),
    (("repair", "maintenance"), {"schedule_c": "21", "f1120": "14", "f1120s": "9", "f1065": "11"}),
    (("supplies",), {"schedule_c": "22"}),
    (("tax", "licen"), {"schedule_c": "23", "f1120": "17", "f1120s": "12", "f1065": "14"}),
    (("travel",), {"schedule_c": "24a"}),
    (("meal", "entertain"), {"schedule_c": "24b"}),
    (("utilit", "phone", "internet"), {"schedule_c": "25"}),
    (("wage", "salar", "payroll"), {"schedule_c": "26", "f1120": "13", "f1120s": "8", "f1065": "9"}),
    (("bad debt",), {"f1120": "15", "f1120s": "10", "f1065": "12"}),
    (("charit", "donation"), {"f1120": "19"}),
    (("retirement", "pension", "401k", "401(k)"), {"schedule_c": "19", "f1120": "23", "f1120s": "17", "f1065": "18"}),
    (("benefit", "health plan"), {"schedule_c": "14", "f1120": "24", "f1120s": "18", "f1065": "19"}),
]
OTHER_EXPENSE = {"schedule_c": "27a", "f1120": "26", "f1120s": "20", "f1065": "21"}
OTHER_INCOME = {"schedule_c": "6", "f1120": "10", "f1120s": "5", "f1065": "7"}
GROSS = {"schedule_c": "1", "f1120": "1a", "f1120s": "1a", "f1065": "1a"}
COGS = {"schedule_c": "4", "f1120": "2", "f1120s": "2", "f1065": "2"}


def suggest(account, form_key):
    """Best-guess return line for an income or expense account."""
    if form_key == CUSTOM_KEY or account.type not in ("income", "expense"):
        return None
    name = f" {account.name.lower()} "
    if account.type == "income":
        if "interest" in name and form_key == "f1120":
            return "5"
        if "rent" in name and form_key == "f1120":
            return "6"
        if account.subtype == "other_income":
            return OTHER_INCOME[form_key]
        if "return" in name or "refund" in name or "discount" in name:
            return "2" if form_key == "schedule_c" else "1b"
        return GROSS[form_key]
    if account.subtype == SUBTYPE_COGS:
        return COGS[form_key]
    if account.subtype == "payroll_tax_expense":
        return {"schedule_c": "23", "f1120": "17", "f1120s": "12", "f1065": "14"}[form_key]
    if account.subtype == "payroll_expense":
        return {"schedule_c": "26", "f1120": "13", "f1120s": "8", "f1065": "9"}[form_key]
    for words, lines in KEYWORDS:
        if any(w in name for w in words) and form_key in lines:
            return lines[form_key]
    return OTHER_EXPENSE[form_key]


def _pl_accounts():
    return Account.query.filter(Account.type.in_(("income", "expense"))).order_by(Account.code).all()


@bp.get("/income-tax/setup")
def income_tax_setup():
    form_key = _setting("income_tax_form", "")
    form = _form(form_key) if form_key else None
    mapping = _mappings(form_key) if form_key else {}
    return jsonify(
        {
            "form": form_key,
            "forms": [{"key": k, "name": v[0], "entity": v[1]} for k, v in FORMS.items()] + [{"key": CUSTOM_KEY, "name": "Custom tax categories", "entity": "Any country – define your own lines"}],
            "lines": [{"code": c, "label": l, "kind": k, "note": n} for c, l, k, n in (form[2] if form else [])],
            "custom_lines": [{"code": c, "label": l, "kind": k, "note": n} for c, l, k, n in _custom_lines()],
            "accounts": [
                {**a.to_dict(), "line": mapping.get(a.id), "suggested": suggest(a, form_key) if form_key else None}
                for a in _pl_accounts()
            ],
        }
    )


@bp.put("/income-tax/setup")
def update_income_tax_setup():
    require_admin()
    data = body()
    if "custom_lines" in data:
        lines, seen = [], set()
        for l in data.get("custom_lines") or []:
            code, label = str(l.get("code") or "").strip(), str(l.get("label") or "").strip()
            if not code or not label:
                raise ApiError("Each custom line needs a code and a name")
            if code in seen:
                raise ApiError(f"Line code {code} is used twice")
            if l.get("kind", "expense") not in ("income", "contra", "cogs", "expense"):
                raise ApiError("Line kind must be income, contra, cogs or expense")
            seen.add(code)
            lines.append({"code": code, "label": label, "kind": l.get("kind", "expense"), "note": str(l.get("note") or "")})
        _set("income_tax_custom_lines", json.dumps(lines))
    if "form" in data:
        if data["form"] not in FORMS and data["form"] != CUSTOM_KEY:
            raise ApiError("Unknown tax return type")
        _set("income_tax_form", data["form"])
    db.session.commit()
    return income_tax_setup()


@bp.put("/income-tax/mappings")
def update_income_tax_mappings():
    form_key = _setting("income_tax_form", "")
    _, _, lines = _form(form_key)
    codes = {c for c, *_ in lines}
    mapping = _mappings(form_key)
    for account_id, line in (body().get("mappings") or {}).items():
        account = db.session.get(Account, int(account_id))
        if account is None or account.type not in ("income", "expense"):
            raise ApiError("Only income and expense accounts are mapped to return lines")
        if line and line not in codes:
            raise ApiError(f"Line {line} is not on this return")
        mapping[account.id] = line or None
    _save_mappings(form_key, mapping)
    db.session.commit()
    return income_tax_setup()


@bp.post("/income-tax/auto-map")
def auto_map():
    form_key = _setting("income_tax_form", "")
    _form(form_key)
    mapping = _mappings(form_key)
    changed = 0
    for a in _pl_accounts():
        if not mapping.get(a.id):
            s = suggest(a, form_key)
            if s:
                mapping[a.id] = s
                changed += 1
    _save_mappings(form_key, mapping)
    db.session.commit()
    return jsonify({"mapped": changed})


def tax_year_bounds(year):
    """Tax year `year` starts in the company's fiscal-year start month of that year (January = calendar year)."""
    from datetime import timedelta

    month = int(_setting("fiscal_year_start_month", "1") or 1)
    start = date(year, month, 1)
    end = date(year + 1, month, 1) - timedelta(days=1)
    return start, end


@bp.get("/income-tax/summary")
def income_tax_summary():
    form_key = _setting("income_tax_form", "")
    name, entity, lines = _form(form_key)
    year = request.args.get("year", type=int) or date.today().year
    start, end = tax_year_bounds(year)
    mapping = _mappings(form_key)
    balances = {a.id: (a, bal) for a, bal in account_balances(start, end) if a.type in ("income", "expense")}
    by_line = {code: {"code": code, "label": label, "kind": kind, "note": note, "amount": 0, "accounts": []} for code, label, kind, note in lines}
    unmapped = []
    for account_id, (a, bal) in balances.items():
        if bal == 0:
            continue
        line = mapping.get(account_id)
        if line not in by_line:
            unmapped.append({"account_id": a.id, "account": a.label, "type": a.type, "amount": money(bal), "suggested": suggest(a, form_key)})
            continue
        by_line[line]["amount"] += bal
        by_line[line]["accounts"].append({"account_id": a.id, "account": a.label, "amount": money(bal)})
    income = sum(l["amount"] for l in by_line.values() if l["kind"] == "income")
    contra = sum(l["amount"] for l in by_line.values() if l["kind"] == "contra")
    cogs = sum(l["amount"] for l in by_line.values() if l["kind"] == "cogs")
    expenses = sum(l["amount"] for l in by_line.values() if l["kind"] == "expense")
    meals_lines = [l for l in by_line.values() if "50%" in l["note"] and l["amount"]]
    notes = []
    if unmapped:
        notes.append(f"{len(unmapped)} account(s) with activity are not mapped to a line, so the totals are incomplete.")
    for l in meals_lines:
        if l["code"] == "24b":
            notes.append(f"Meals of {money(l['amount']):,.2f} are on line 24b; generally only 50% ({money(l['amount'] // 2):,.2f}) is deductible.")
    notes.append("Figures are from your books for the tax year and are a starting point for the return, not the return itself. Book depreciation, meals limits, owner draws, and other book-to-tax differences may require adjustments. Confirm line numbers against the current year's form.")
    return jsonify(
        {
            "form": form_key,
            "form_name": name,
            "entity": entity,
            "year": year,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "lines": [{**l, "amount": money(l["amount"])} for l in by_line.values()],
            "unmapped": unmapped,
            "totals": {
                "gross_income": money(income - contra),
                "cost_of_goods_sold": money(cogs),
                "gross_profit": money(income - contra - cogs),
                "deductions": money(expenses),
                "net_profit": money(income - contra - cogs - expenses),
            },
            "notes": notes,
        }
    )
