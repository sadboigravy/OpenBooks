"""Double-entry posting and balance queries."""
from sqlalchemy import func

from .models import Account, JournalEntry, JournalLine, db
from .util import ApiError


def post_entry(*, date, memo, lines, source_type, source_id=None, reference="", entry=None):
    """Create (or replace the lines of) a balanced journal entry.

    ``lines`` is a list of dicts: {account_id, debit, credit, description}
    with debit/credit in integer cents.
    """
    clean = []
    for line in lines:
        debit, credit = int(line.get("debit") or 0), int(line.get("credit") or 0)
        if debit == 0 and credit == 0:
            continue
        if debit < 0 or credit < 0:
            raise ApiError("Debit and credit amounts cannot be negative")
        if debit and credit:
            raise ApiError("A journal line cannot have both a debit and a credit")
        account = db.session.get(Account, line.get("account_id"))
        if account is None:
            raise ApiError("Every journal line needs a valid account")
        clean.append(
            JournalLine(
                account_id=account.id,
                debit=debit,
                credit=credit,
                description=line.get("description") or "",
            )
        )

    total_debit = sum(l.debit for l in clean)
    total_credit = sum(l.credit for l in clean)
    if len(clean) < 2 or total_debit == 0:
        raise ApiError("A journal entry needs at least two lines with amounts")
    if total_debit != total_credit:
        raise ApiError(
            f"Debits ({total_debit / 100:.2f}) must equal credits ({total_credit / 100:.2f})"
        )

    if entry is None:
        entry = JournalEntry()
        db.session.add(entry)
    else:
        ensure_not_reconciled(entry)
        entry.lines.clear()
    entry.date = date
    entry.memo = memo or ""
    entry.reference = reference or ""
    entry.source_type = source_type
    entry.source_id = source_id
    entry.lines.extend(clean)
    db.session.flush()
    return entry


def ensure_not_reconciled(entry):
    if any(l.reconciliation_id for l in entry.lines):
        raise ApiError(
            "This transaction is part of a completed reconciliation. "
            "Undo that reconciliation before changing or deleting it."
        )


def delete_entry(entry_id):
    if entry_id:
        entry = db.session.get(JournalEntry, entry_id)
        if entry is not None:
            ensure_not_reconciled(entry)
            db.session.delete(entry)
            db.session.flush()


def raw_balances(start=None, end=None):
    """Return {account_id: debit_sum - credit_sum} for entries in the date range."""
    q = db.session.query(
        JournalLine.account_id,
        func.coalesce(func.sum(JournalLine.debit), 0),
        func.coalesce(func.sum(JournalLine.credit), 0),
    ).join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
    if start is not None:
        q = q.filter(JournalEntry.date >= start)
    if end is not None:
        q = q.filter(JournalEntry.date <= end)
    q = q.group_by(JournalLine.account_id)
    return {acct_id: int(d) - int(c) for acct_id, d, c in q.all()}


def natural(account, raw):
    """Convert a raw (debit - credit) amount to the account's normal-balance sign."""
    return raw if account.debit_normal else -raw


def account_balances(start=None, end=None):
    """Return list of (account, natural_balance_cents) for all accounts."""
    raw = raw_balances(start, end)
    accounts = Account.query.order_by(Account.code).all()
    return [(a, natural(a, raw.get(a.id, 0))) for a in accounts]


def system_account(subtype):
    account = Account.query.filter_by(subtype=subtype).order_by(Account.code).first()
    if account is None:
        raise ApiError(f"No '{subtype.replace('_', ' ')}' account exists in the chart of accounts")
    return account
