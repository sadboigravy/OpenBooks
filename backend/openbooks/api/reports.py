from datetime import date

from flask import jsonify, request

from ..ledger import account_balances, natural, raw_balances
from ..models import SUBTYPE_COGS, SUBTYPE_RETAINED, Account, Bill, Invoice, JournalEntry, JournalLine, money
from ..util import ApiError, arg_date
from . import bp


def fiscal_year_start(as_of):
    from .settings import get_settings

    month = int(get_settings().get("fiscal_year_start_month") or 1)
    year = as_of.year if as_of.month >= month else as_of.year - 1
    return date(year, month, 1)


def _rows(pairs):
    return [
        {"account_id": a.id, "code": a.code, "name": a.name, "amount": money(bal)}
        for a, bal in pairs
        if bal != 0
    ]


def profit_and_loss_data(start, end):
    pairs = account_balances(start, end)
    income = [(a, b) for a, b in pairs if a.type == "income"]
    cogs = [(a, b) for a, b in pairs if a.type == "expense" and a.subtype == SUBTYPE_COGS]
    expenses = [(a, b) for a, b in pairs if a.type == "expense" and a.subtype != SUBTYPE_COGS]
    total_income = sum(b for _, b in income)
    total_cogs = sum(b for _, b in cogs)
    total_expenses = sum(b for _, b in expenses)
    return {
        "income_cents": total_income,
        "expense_cents": total_cogs + total_expenses,
        "net_cents": total_income - total_cogs - total_expenses,
        "sections": [
            {"title": "Income", "rows": _rows(income), "total": money(total_income)},
            {"title": "Cost of Goods Sold", "rows": _rows(cogs), "total": money(total_cogs)},
            {"title": "Expenses", "rows": _rows(expenses), "total": money(total_expenses)},
        ],
        "gross_profit": money(total_income - total_cogs),
    }


@bp.get("/reports/profit-loss")
def profit_and_loss():
    end = arg_date("end", date.today())
    start = arg_date("start", fiscal_year_start(end))
    if start > end:
        raise ApiError("The start date must be before the end date")
    data = profit_and_loss_data(start, end)
    return jsonify(
        {
            "title": "Profit and Loss",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "sections": data["sections"],
            "gross_profit": data["gross_profit"],
            "total_income": money(data["income_cents"]),
            "total_expenses": money(data["expense_cents"]),
            "net_income": money(data["net_cents"]),
        }
    )


@bp.get("/reports/balance-sheet")
def balance_sheet():
    as_of = arg_date("as_of", date.today())
    fy_start = fiscal_year_start(as_of)
    pairs = account_balances(end=as_of)

    assets = [(a, b) for a, b in pairs if a.type == "asset"]
    liabilities = [(a, b) for a, b in pairs if a.type == "liability"]
    equity = [(a, b) for a, b in pairs if a.type == "equity"]

    # Income and expenses are not closed out to equity, so compute earnings on the fly.
    def earnings(start, end):
        raw = raw_balances(start, end)
        total = 0
        for a in Account.query.filter(Account.type.in_(("income", "expense"))).all():
            total += natural(a, raw.get(a.id, 0)) * (1 if a.type == "income" else -1)
        return total

    prior = earnings(None, date.fromordinal(fy_start.toordinal() - 1))
    current = earnings(fy_start, as_of)

    equity_rows = _rows(equity)
    retained = next((a for a, _ in equity if a.subtype == SUBTYPE_RETAINED), None)
    if prior:
        existing = next((r for r in equity_rows if retained and r["account_id"] == retained.id), None)
        if existing:
            existing["amount"] = money(round(existing["amount"] * 100) + prior)
        else:
            equity_rows.append(
                {"account_id": retained.id if retained else None, "code": retained.code if retained else "", "name": "Retained Earnings", "amount": money(prior)}
            )
    equity_rows.append({"account_id": None, "code": "", "name": "Net Income (current fiscal year)", "amount": money(current)})

    total_assets = sum(b for _, b in assets)
    total_liabilities = sum(b for _, b in liabilities)
    total_equity = sum(b for _, b in equity) + prior + current
    return jsonify(
        {
            "title": "Balance Sheet",
            "as_of": as_of.isoformat(),
            "sections": [
                {"title": "Assets", "rows": _rows(assets), "total": money(total_assets)},
                {"title": "Liabilities", "rows": _rows(liabilities), "total": money(total_liabilities)},
                {"title": "Equity", "rows": equity_rows, "total": money(total_equity)},
            ],
            "total_assets": money(total_assets),
            "total_liabilities_and_equity": money(total_liabilities + total_equity),
            "balanced": total_assets == total_liabilities + total_equity,
        }
    )


@bp.get("/reports/trial-balance")
def trial_balance():
    as_of = arg_date("as_of", date.today())
    raw = raw_balances(end=as_of)
    rows = []
    total_debit = total_credit = 0
    for a in Account.query.order_by(Account.code).all():
        bal = raw.get(a.id, 0)
        if bal == 0:
            continue
        debit, credit = (bal, 0) if bal > 0 else (0, -bal)
        total_debit += debit
        total_credit += credit
        rows.append({"account_id": a.id, "code": a.code, "name": a.name, "type": a.type, "debit": money(debit), "credit": money(credit)})
    return jsonify(
        {
            "title": "Trial Balance",
            "as_of": as_of.isoformat(),
            "rows": rows,
            "total_debit": money(total_debit),
            "total_credit": money(total_credit),
        }
    )


@bp.get("/reports/general-ledger")
def general_ledger():
    end = arg_date("end", date.today())
    start = arg_date("start", fiscal_year_start(end))
    account_id = request.args.get("account_id", type=int)
    q = Account.query.order_by(Account.code)
    if account_id:
        q = q.filter_by(id=account_id)
    opening_raw = raw_balances(end=date.fromordinal(start.toordinal() - 1))
    accounts = []
    for a in q.all():
        lines = (
            JournalLine.query.join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
            .filter(JournalLine.account_id == a.id, JournalEntry.date >= start, JournalEntry.date <= end)
            .order_by(JournalEntry.date, JournalEntry.id, JournalLine.id)
            .all()
        )
        opening = natural(a, opening_raw.get(a.id, 0))
        if not lines and opening == 0 and not account_id:
            continue
        running = opening
        rows = []
        for l in lines:
            running += natural(a, l.debit - l.credit)
            rows.append(
                {
                    "date": l.entry.date.isoformat(),
                    "entry_id": l.entry_id,
                    "source_type": l.entry.source_type,
                    "source_id": l.entry.source_id,
                    "reference": l.entry.reference,
                    "memo": l.description if l.description and l.description != l.entry.memo else l.entry.memo,
                    "debit": money(l.debit),
                    "credit": money(l.credit),
                    "balance": money(running),
                }
            )
        accounts.append(
            {
                "account_id": a.id,
                "code": a.code,
                "name": a.name,
                "type": a.type,
                "opening": money(opening),
                "closing": money(running),
                "rows": rows,
            }
        )
    return jsonify({"title": "General Ledger", "start": start.isoformat(), "end": end.isoformat(), "accounts": accounts})


def _aging(docs, contact_attr, as_of):
    buckets = ("current", "1_30", "31_60", "61_90", "over_90")
    by_contact = {}
    for doc in docs:
        bal = doc.balance_cents
        if bal <= 0:
            continue
        days = (as_of - doc.due_date).days
        bucket = (
            "current" if days <= 0 else "1_30" if days <= 30 else "31_60" if days <= 60 else "61_90" if days <= 90 else "over_90"
        )
        contact = getattr(doc, contact_attr)
        row = by_contact.setdefault(contact.id, {"contact_id": contact.id, "name": contact.name, **{b: 0 for b in buckets}, "total": 0, "docs": []})
        row[bucket] += bal
        row["total"] += bal
        row["docs"].append(
            {"id": doc.id, "number": doc.number, "date": doc.date.isoformat(), "due_date": doc.due_date.isoformat(), "days_overdue": max(days, 0), "balance": money(bal)}
        )
    rows = sorted(by_contact.values(), key=lambda r: r["name"].lower())
    totals = {b: money(sum(r[b] for r in rows)) for b in buckets + ("total",)}
    for r in rows:
        for b in buckets + ("total",):
            r[b] = money(r[b])
    return {"as_of": as_of.isoformat(), "rows": rows, "totals": totals}


@bp.get("/reports/ar-aging")
def ar_aging():
    as_of = arg_date("as_of", date.today())
    docs = Invoice.query.filter(Invoice.status == "open").all()
    return jsonify({"title": "Accounts Receivable Aging", **_aging(docs, "customer", as_of)})


@bp.get("/reports/ap-aging")
def ap_aging():
    as_of = arg_date("as_of", date.today())
    docs = Bill.query.filter(Bill.status == "open").all()
    return jsonify({"title": "Accounts Payable Aging", **_aging(docs, "vendor", as_of)})
