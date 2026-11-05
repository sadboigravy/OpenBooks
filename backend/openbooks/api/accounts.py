from flask import jsonify, request

from ..ledger import account_balances, delete_entry, post_entry
from ..models import ACCOUNT_TYPES, Account, JournalEntry, JournalLine, db
from ..util import ApiError, body, get_or_404, opt_str, parse_date, required_str, to_cents
from . import bp

SUBTYPES = {
    "asset": ["bank", "cash", "accounts_receivable", "other_current_asset", "fixed_asset", "other_asset"],
    "liability": ["accounts_payable", "credit_card", "sales_tax", "payroll_liability", "other_current_liability", "long_term_liability"],
    "equity": ["owner_equity", "retained_earnings"],
    "income": ["income", "other_income"],
    "expense": ["cost_of_goods_sold", "expense", "payroll_expense", "payroll_tax_expense", "other_expense"],
}


@bp.get("/accounts")
def list_accounts():
    include_inactive = request.args.get("include_inactive") == "1"
    result = []
    for account, balance in account_balances():
        if account.active or include_inactive:
            result.append(account.to_dict(balance))
    return jsonify(result)


@bp.get("/accounts/subtypes")
def account_subtypes():
    return jsonify(SUBTYPES)


def _apply(account, data, creating):
    code = required_str(data, "code", "Account number")
    clash = Account.query.filter(Account.code == code)
    if not creating:
        clash = clash.filter(Account.id != account.id)
    if clash.first():
        raise ApiError(f"Account number {code} is already used")
    type_ = data.get("type")
    if type_ not in ACCOUNT_TYPES:
        raise ApiError("Choose an account type")
    subtype = data.get("subtype") or SUBTYPES[type_][0]
    if subtype not in SUBTYPES[type_]:
        raise ApiError("That detail type does not match the account type")
    if account.is_system and (type_ != account.type or subtype != account.subtype):
        raise ApiError("The type of a system account cannot be changed")
    if not creating and type_ != account.type and JournalLine.query.filter_by(account_id=account.id).first():
        raise ApiError("The type of an account with transactions cannot be changed")
    account.code = code
    account.name = required_str(data, "name")
    account.type = type_
    account.subtype = subtype
    account.description = opt_str(data, "description")
    if "active" in data:
        if not data["active"] and account.is_system:
            raise ApiError("System accounts cannot be deactivated")
        account.active = bool(data["active"])


@bp.post("/accounts")
def create_account():
    account = Account()
    _apply(account, body(), creating=True)
    db.session.add(account)
    db.session.commit()
    return jsonify(account.to_dict(0)), 201


@bp.put("/accounts/<int:account_id>")
def update_account(account_id):
    account = get_or_404(Account, account_id, "Account")
    _apply(account, body(), creating=False)
    db.session.commit()
    return jsonify(account.to_dict())


@bp.delete("/accounts/<int:account_id>")
def delete_account(account_id):
    account = get_or_404(Account, account_id, "Account")
    if account.is_system:
        raise ApiError("System accounts cannot be deleted")
    if JournalLine.query.filter_by(account_id=account.id).first():
        raise ApiError("This account has transactions. Make it inactive instead of deleting it.")
    from ..models import BankTransaction, BillLine, Expense, ExpenseLine, InvoiceLine, Payment

    for model, col in (
        (InvoiceLine, InvoiceLine.account_id),
        (BillLine, BillLine.account_id),
        (ExpenseLine, ExpenseLine.account_id),
        (Expense, Expense.account_id),
        (Payment, Payment.account_id),
        (BankTransaction, BankTransaction.account_id),
    ):
        if model.query.filter(col == account.id).first():
            raise ApiError("This account is used by existing records. Make it inactive instead.")
    db.session.delete(account)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- journal entries


@bp.get("/journal-entries")
def list_journal_entries():
    q = JournalEntry.query
    source = request.args.get("source")
    if source:
        q = q.filter(JournalEntry.source_type == source)
    start = request.args.get("start")
    end = request.args.get("end")
    if start:
        q = q.filter(JournalEntry.date >= parse_date(start, "start"))
    if end:
        q = q.filter(JournalEntry.date <= parse_date(end, "end"))
    limit = min(int(request.args.get("limit", 200)), 1000)
    entries = q.order_by(JournalEntry.date.desc(), JournalEntry.id.desc()).limit(limit).all()
    return jsonify([e.to_dict() for e in entries])


@bp.get("/journal-entries/<int:entry_id>")
def get_journal_entry(entry_id):
    return jsonify(get_or_404(JournalEntry, entry_id, "Journal entry").to_dict())


def _manual_lines(data):
    lines = data.get("lines")
    if not isinstance(lines, list):
        raise ApiError("Add the journal lines")
    return [
        {
            "account_id": l.get("account_id"),
            "debit": to_cents(l.get("debit"), "debit"),
            "credit": to_cents(l.get("credit"), "credit"),
            "description": opt_str(l, "description"),
        }
        for l in lines
    ]


@bp.post("/journal-entries")
def create_journal_entry():
    data = body()
    entry = post_entry(
        date=parse_date(data.get("date")),
        memo=opt_str(data, "memo"),
        reference=opt_str(data, "reference"),
        source_type="manual",
        lines=_manual_lines(data),
    )
    db.session.commit()
    return jsonify(entry.to_dict()), 201


def _manual_entry(entry_id, allowed=("manual",)):
    entry = get_or_404(JournalEntry, entry_id, "Journal entry")
    if entry.source_type not in allowed:
        raise ApiError(
            f"This entry was created by a {entry.source_type.replace('_', ' ')}. Edit that record instead."
        )
    return entry


@bp.put("/journal-entries/<int:entry_id>")
def update_journal_entry(entry_id):
    entry = _manual_entry(entry_id)
    data = body()
    post_entry(
        date=parse_date(data.get("date")),
        memo=opt_str(data, "memo"),
        reference=opt_str(data, "reference"),
        source_type="manual",
        lines=_manual_lines(data),
        entry=entry,
    )
    db.session.commit()
    return jsonify(entry.to_dict())


@bp.delete("/journal-entries/<int:entry_id>")
def delete_journal_entry(entry_id):
    entry = _manual_entry(entry_id, ("manual", "deposit", "transfer", "payroll_tax_payment"))
    delete_entry(entry.id)
    db.session.commit()
    return jsonify({"ok": True})
