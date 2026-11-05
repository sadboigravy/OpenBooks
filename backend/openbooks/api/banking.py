import csv
import io
from datetime import datetime

from flask import jsonify, request

from ..ledger import delete_entry, post_entry, raw_balances
from ..models import BANK_SUBTYPES, Account, BankTransaction, JournalLine, db, money
from ..util import ApiError, body, get_or_404, opt_str, parse_date, to_cents
from . import bp


def _bank_account(account_id):
    account = db.session.get(Account, account_id)
    if account is None or account.subtype not in BANK_SUBTYPES:
        raise ApiError("Choose a bank, cash or credit card account")
    return account


def create_bank_transaction(account_id, date_value, description, amount):
    account = _bank_account(account_id)
    cents = to_cents(amount, "amount", allow_negative=True, allow_zero=False)
    tx = BankTransaction(
        account_id=account.id,
        date=parse_date(date_value),
        description=(description or "").strip() or "(no description)",
        amount=cents,
    )
    db.session.add(tx)
    db.session.flush()
    return tx


@bp.get("/bank/accounts")
def bank_accounts():
    balances = raw_balances()
    result = []
    for a in Account.query.filter(Account.subtype.in_(BANK_SUBTYPES), Account.active.is_(True)).order_by(Account.code):
        txs = BankTransaction.query.filter_by(account_id=a.id)
        statement = sum(t.amount for t in txs.filter(BankTransaction.status != "excluded").all())
        d = a.to_dict(balances.get(a.id, 0) if a.debit_normal else -balances.get(a.id, 0))
        d["to_review"] = txs.filter_by(status="review").count()
        d["feed_total"] = money(statement)
        result.append(d)
    return jsonify(result)


@bp.get("/bank/transactions")
def list_bank_transactions():
    q = BankTransaction.query
    if request.args.get("account_id"):
        q = q.filter_by(account_id=int(request.args["account_id"]))
    status = request.args.get("status")
    if status:
        q = q.filter_by(status=status)
    rows = q.order_by(BankTransaction.date.desc(), BankTransaction.id.desc()).all()
    return jsonify([t.to_dict() for t in rows])


@bp.post("/bank/transactions")
def add_bank_transaction():
    data = body()
    tx = create_bank_transaction(data.get("account_id"), data.get("date"), data.get("description"), data.get("amount"))
    db.session.commit()
    return jsonify(tx.to_dict()), 201


def _parse_amount(text):
    text = (text or "").strip().replace("$", "").replace(",", "").replace("£", "").replace("€", "")
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()")
    value = float(text)
    return -value if negative else value


def _parse_csv_date(text):
    text = (text or "").strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%b %d, %Y", "%d %b %Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ApiError(f"Could not read the date '{text}'")


@bp.post("/bank/import")
def import_csv():
    """Import a bank statement CSV.

    Needs a header row with a date column, a description column and either an
    amount column or separate debit/withdrawal and credit/deposit columns.
    """
    data = body()
    account = _bank_account(data.get("account_id"))
    text = str(data.get("csv") or "")
    if not text.strip():
        raise ApiError("The file is empty")
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    headers = {h.strip().lower(): h for h in (reader.fieldnames or []) if h}

    def find(*names):
        for name in names:
            for low, original in headers.items():
                if name in low:
                    return original
        return None

    col_date = find("date")
    col_desc = find("description", "payee", "memo", "details", "name", "narrative")
    col_amount = find("amount")
    col_out = find("debit", "withdrawal", "money out", "paid out")
    col_in = find("credit", "deposit", "money in", "paid in")
    if not col_date or not (col_amount or col_out or col_in):
        raise ApiError("The CSV needs a header row with a Date column and an Amount (or Debit/Credit) column")

    is_credit_card = account.subtype == "credit_card"
    created, skipped = 0, 0
    for row_no, row in enumerate(reader, start=2):
        if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
            continue
        try:
            tx_date = _parse_csv_date(row.get(col_date))
            if col_amount and (row.get(col_amount) or "").strip():
                amount = _parse_amount(row.get(col_amount))
            else:
                out = _parse_amount(row.get(col_out)) if col_out else None
                inn = _parse_amount(row.get(col_in)) if col_in else None
                amount = (inn or 0) - abs(out or 0)
        except (ValueError, ApiError) as exc:
            raise ApiError(f"Row {row_no}: {getattr(exc, 'message', exc)}")
        if not amount:
            continue
        description = (row.get(col_desc) or "").strip() if col_desc else ""
        cents = int(round(amount * 100))
        if data.get("flip_sign"):
            cents = -cents
        duplicate = BankTransaction.query.filter_by(
            account_id=account.id, date=tx_date, amount=cents, description=description or "(no description)"
        ).first()
        if duplicate:
            skipped += 1
            continue
        db.session.add(
            BankTransaction(account_id=account.id, date=tx_date, description=description or "(no description)", amount=cents)
        )
        created += 1
    db.session.commit()
    return jsonify({"imported": created, "skipped_duplicates": skipped, "credit_card": is_credit_card})


def _post_bank_tx(tx, category):
    bank = db.session.get(Account, tx.account_id)
    amount = abs(tx.amount)
    if tx.amount > 0:  # money in
        lines = [{"account_id": bank.id, "debit": amount}, {"account_id": category.id, "credit": amount}]
    else:
        lines = [{"account_id": category.id, "debit": amount}, {"account_id": bank.id, "credit": amount}]
    entry = post_entry(
        date=tx.date,
        memo=tx.description,
        source_type="bank",
        source_id=tx.id,
        lines=lines,
    )
    tx.journal_entry_id = entry.id


@bp.post("/bank/transactions/<int:tx_id>/categorize")
def categorize(tx_id):
    tx = get_or_404(BankTransaction, tx_id, "Transaction")
    data = body()
    category = db.session.get(Account, data.get("account_id"))
    if category is None:
        raise ApiError("Choose a category")
    if category.id == tx.account_id:
        raise ApiError("A transaction cannot be categorised to its own bank account")
    if category.subtype in ("accounts_receivable", "accounts_payable"):
        raise ApiError(
            "To record a customer or vendor payment, use Receive payment on the invoice or Pay bill, "
            "then Exclude this bank line so it isn't counted twice."
        )
    delete_entry(tx.journal_entry_id)
    tx.category_account_id = category.id
    if "description" in data and opt_str(data, "description"):
        tx.description = opt_str(data, "description")
    _post_bank_tx(tx, category)
    tx.status = "categorized"
    db.session.commit()
    return jsonify(tx.to_dict())


@bp.post("/bank/transactions/<int:tx_id>/exclude")
def exclude(tx_id):
    tx = get_or_404(BankTransaction, tx_id, "Transaction")
    delete_entry(tx.journal_entry_id)
    tx.journal_entry_id = None
    tx.category_account_id = None
    tx.status = "excluded"
    db.session.commit()
    return jsonify(tx.to_dict())


@bp.post("/bank/transactions/<int:tx_id>/undo")
def undo(tx_id):
    tx = get_or_404(BankTransaction, tx_id, "Transaction")
    if tx.reconciled:
        raise ApiError("Un-reconcile this transaction first")
    delete_entry(tx.journal_entry_id)
    tx.journal_entry_id = None
    tx.category_account_id = None
    tx.status = "review"
    db.session.commit()
    return jsonify(tx.to_dict())


@bp.post("/bank/transactions/<int:tx_id>/reconcile")
def reconcile(tx_id):
    tx = get_or_404(BankTransaction, tx_id, "Transaction")
    if tx.status != "categorized":
        raise ApiError("Only categorised transactions can be reconciled")
    tx.reconciled = bool(body().get("reconciled", True))
    db.session.commit()
    return jsonify(tx.to_dict())


@bp.delete("/bank/transactions/<int:tx_id>")
def delete_bank_tx(tx_id):
    tx = get_or_404(BankTransaction, tx_id, "Transaction")
    if tx.status == "categorized":
        raise ApiError("Undo the categorisation before deleting this transaction")
    db.session.delete(tx)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/bank/register/<int:account_id>")
def register(account_id):
    """Every ledger line that touches a bank account, newest first, with a running balance."""
    account = _bank_account(account_id)
    lines = (
        JournalLine.query.filter_by(account_id=account.id)
        .join(JournalLine.entry)
        .all()
    )
    lines.sort(key=lambda l: (l.entry.date, l.entry.id, l.id))
    running = 0
    rows = []
    for l in lines:
        change = (l.debit - l.credit) if account.debit_normal else (l.credit - l.debit)
        running += change
        rows.append(
            {
                "date": l.entry.date.isoformat(),
                "entry_id": l.entry_id,
                "memo": l.entry.memo,
                "source_type": l.entry.source_type,
                "source_id": l.entry.source_id,
                "amount": money(change),
                "balance": money(running),
            }
        )
    rows.reverse()
    return jsonify(rows)


# ---------------------------------------------------------------- deposits & transfers
# These are stored purely as journal entries (source_type "deposit" / "transfer").


def _entry_of(entry_id, source_type):
    from ..models import JournalEntry

    entry = get_or_404(JournalEntry, entry_id, source_type.capitalize())
    if entry.source_type != source_type:
        raise ApiError(f"That is not a {source_type}", 404)
    return entry


def _save_deposit(data, entry=None):
    bank = db.session.get(Account, data.get("account_id"))
    if bank is None or bank.subtype not in ("bank", "cash"):
        raise ApiError("Choose the bank account the money was deposited into")
    credits = []
    for raw in data.get("lines") or []:
        amount = to_cents(raw.get("amount"), "amount", allow_negative=True)
        if amount == 0:
            continue
        source = db.session.get(Account, raw.get("account_id"))
        if source is None:
            raise ApiError("Each deposit line needs a 'received from' account")
        if source.id == bank.id:
            raise ApiError("A deposit line cannot use the account being deposited into")
        if source.subtype in ("accounts_receivable",):
            raise ApiError("To deposit an invoice payment, use Receive payment instead")
        line = {"account_id": source.id, "description": opt_str(raw, "description")}
        line["credit" if amount > 0 else "debit"] = abs(amount)
        credits.append(line)
    if not credits:
        raise ApiError("Add at least one deposit line")
    total = sum(l.get("credit", 0) - l.get("debit", 0) for l in credits)
    if total <= 0:
        raise ApiError("The deposit total must be greater than zero")
    return post_entry(
        date=parse_date(data.get("date")),
        memo=opt_str(data, "memo") or f"Deposit to {bank.name}",
        reference=opt_str(data, "reference"),
        source_type="deposit",
        lines=[{"account_id": bank.id, "debit": total, "description": "Deposit"}] + credits,
        entry=entry,
    )


def _deposit_dict(entry):
    bank_line = entry.lines[0]
    return {
        "id": entry.id,
        "date": entry.date.isoformat(),
        "account_id": bank_line.account_id,
        "memo": entry.memo,
        "reference": entry.reference,
        "total": money(bank_line.debit),
        "lines": [
            {"account_id": l.account_id, "description": l.description, "amount": money(l.credit - l.debit)}
            for l in entry.lines[1:]
        ],
    }


@bp.get("/deposits/<int:entry_id>")
def get_deposit(entry_id):
    return jsonify(_deposit_dict(_entry_of(entry_id, "deposit")))


@bp.post("/deposits")
def create_deposit():
    entry = _save_deposit(body())
    db.session.commit()
    return jsonify(_deposit_dict(entry)), 201


@bp.put("/deposits/<int:entry_id>")
def update_deposit(entry_id):
    entry = _save_deposit(body(), _entry_of(entry_id, "deposit"))
    db.session.commit()
    return jsonify(_deposit_dict(entry))


def _save_transfer(data, entry=None):
    src = db.session.get(Account, data.get("from_account_id"))
    dst = db.session.get(Account, data.get("to_account_id"))
    if src is None or dst is None:
        raise ApiError("Choose both accounts")
    if src.id == dst.id:
        raise ApiError("Choose two different accounts")
    if src.type not in ("asset", "liability", "equity") or dst.type not in ("asset", "liability", "equity"):
        raise ApiError("Transfers are between bank, cash, credit card, loan or equity accounts")
    amount = to_cents(data.get("amount"), "amount", allow_zero=False)
    return post_entry(
        date=parse_date(data.get("date")),
        memo=opt_str(data, "memo") or f"Transfer from {src.name} to {dst.name}",
        source_type="transfer",
        lines=[
            {"account_id": dst.id, "debit": amount, "description": "Transfer in"},
            {"account_id": src.id, "credit": amount, "description": "Transfer out"},
        ],
        entry=entry,
    )


def _transfer_dict(entry):
    to_line = next(l for l in entry.lines if l.debit)
    from_line = next(l for l in entry.lines if l.credit)
    return {
        "id": entry.id,
        "date": entry.date.isoformat(),
        "from_account_id": from_line.account_id,
        "to_account_id": to_line.account_id,
        "amount": money(to_line.debit),
        "memo": entry.memo,
    }


@bp.get("/transfers/<int:entry_id>")
def get_transfer(entry_id):
    return jsonify(_transfer_dict(_entry_of(entry_id, "transfer")))


@bp.post("/transfers")
def create_transfer():
    entry = _save_transfer(body())
    db.session.commit()
    return jsonify(_transfer_dict(entry)), 201


@bp.put("/transfers/<int:entry_id>")
def update_transfer(entry_id):
    entry = _save_transfer(body(), _entry_of(entry_id, "transfer"))
    db.session.commit()
    return jsonify(_transfer_dict(entry))


# ---------------------------------------------------------------- reconcile


def _reconcilable(account_id):
    account = db.session.get(Account, account_id)
    if account is None or account.subtype not in BANK_SUBTYPES:
        raise ApiError("Only bank, cash and credit card accounts can be reconciled")
    return account


@bp.get("/reconcile/<int:account_id>")
def reconcile_workspace(account_id):
    from ..models import JournalEntry, Reconciliation

    account = _reconcilable(account_id)
    statement_date = parse_date(request.args.get("statement_date"), "statement date", required=False)
    lines = JournalLine.query.filter_by(account_id=account.id).join(JournalEntry, JournalLine.entry_id == JournalEntry.id).all()
    sign = 1 if account.debit_normal else -1
    beginning = sum(sign * (l.debit - l.credit) for l in lines if l.reconciliation_id)
    open_lines = [l for l in lines if not l.reconciliation_id and (statement_date is None or l.entry.date <= statement_date)]
    open_lines.sort(key=lambda l: (l.entry.date, l.entry_id))
    history = Reconciliation.query.filter_by(account_id=account.id).order_by(Reconciliation.statement_date.desc(), Reconciliation.id.desc()).all()
    return jsonify(
        {
            "account": account.to_dict(),
            "beginning_balance": money(beginning),
            "last_statement_date": history[0].statement_date.isoformat() if history else None,
            "lines": [
                {
                    "id": l.id,
                    "date": l.entry.date.isoformat(),
                    "entry_id": l.entry_id,
                    "source_type": l.entry.source_type,
                    "source_id": l.entry.source_id,
                    "reference": l.entry.reference,
                    "memo": l.entry.memo,
                    # increase/decrease of the account's balance
                    "amount": money(sign * (l.debit - l.credit)),
                }
                for l in open_lines
            ],
            "history": [r.to_dict() for r in history],
        }
    )


@bp.post("/reconcile/<int:account_id>")
def finish_reconcile(account_id):
    from ..models import Reconciliation

    account = _reconcilable(account_id)
    data = body()
    statement_date = parse_date(data.get("statement_date"), "statement date")
    ending = to_cents(data.get("ending_balance"), "ending balance", allow_negative=True)
    ids = [int(i) for i in data.get("line_ids") or []]
    sign = 1 if account.debit_normal else -1
    all_lines = JournalLine.query.filter_by(account_id=account.id).all()
    beginning = sum(sign * (l.debit - l.credit) for l in all_lines if l.reconciliation_id)
    chosen = [l for l in all_lines if l.id in ids]
    if len(chosen) != len(ids) or any(l.reconciliation_id for l in chosen):
        raise ApiError("Some selected transactions are invalid or already reconciled")
    if any(l.entry.date > statement_date for l in chosen):
        raise ApiError("Selected transactions must be dated on or before the statement date")
    cleared = beginning + sum(sign * (l.debit - l.credit) for l in chosen)
    if cleared != ending:
        raise ApiError(f"The difference must be 0.00 to finish (it is {(ending - cleared) / 100:.2f})")
    rec = Reconciliation(
        account_id=account.id,
        statement_date=statement_date,
        beginning_balance_cents=beginning,
        ending_balance_cents=ending,
    )
    db.session.add(rec)
    db.session.flush()
    for l in chosen:
        l.reconciliation_id = rec.id
    db.session.commit()
    return jsonify(rec.to_dict()), 201


@bp.post("/reconcile/history/<int:rec_id>/undo")
def undo_reconcile(rec_id):
    from ..models import Reconciliation

    rec = get_or_404(Reconciliation, rec_id, "Reconciliation")
    latest = Reconciliation.query.filter_by(account_id=rec.account_id).order_by(Reconciliation.statement_date.desc(), Reconciliation.id.desc()).first()
    if latest.id != rec.id:
        raise ApiError("Only the most recent reconciliation can be undone")
    JournalLine.query.filter_by(reconciliation_id=rec.id).update({"reconciliation_id": None})
    db.session.delete(rec)
    db.session.commit()
    return jsonify({"ok": True})
