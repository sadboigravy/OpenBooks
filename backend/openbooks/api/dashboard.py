from datetime import date, timedelta

from flask import jsonify

from ..ledger import account_balances
from ..models import BankTransaction, Bill, Invoice, JournalEntry, money
from . import bp
from .reports import fiscal_year_start, profit_and_loss_data


def _month_start(d, back=0):
    y, m = d.year, d.month - back
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


@bp.get("/dashboard")
def dashboard():
    today = date.today()
    pairs = account_balances(end=today)
    cash = sum(b for a, b in pairs if a.subtype in ("bank", "cash"))
    card = sum(b for a, b in pairs if a.subtype == "credit_card")
    receivable = sum(b for a, b in pairs if a.subtype == "accounts_receivable")
    payable = sum(b for a, b in pairs if a.subtype == "accounts_payable")

    month = profit_and_loss_data(_month_start(today), today)
    ytd = profit_and_loss_data(fiscal_year_start(today), today)

    series = []
    for back in range(11, -1, -1):
        start = _month_start(today, back)
        end = _month_start(today, back - 1) - timedelta(days=1) if back > 0 else today
        p = profit_and_loss_data(start, end)
        series.append(
            {"month": start.strftime("%b %Y"), "income": money(p["income_cents"]), "expenses": money(p["expense_cents"])}
        )

    open_invoices = [i for i in Invoice.query.filter_by(status="open").all() if i.balance_cents > 0]
    overdue = sorted([i for i in open_invoices if i.display_status == "overdue"], key=lambda i: i.due_date)
    open_bills = [b for b in Bill.query.filter_by(status="open").all() if b.balance_cents > 0]
    bills_due = sorted(open_bills, key=lambda b: b.due_date)

    recent = JournalEntry.query.order_by(JournalEntry.date.desc(), JournalEntry.id.desc()).limit(8).all()

    return jsonify(
        {
            "cash": money(cash),
            "credit_card": money(card),
            "receivable": money(receivable),
            "payable": money(payable),
            "overdue_total": money(sum(i.balance_cents for i in overdue)),
            "overdue_count": len(overdue),
            "month": {"income": money(month["income_cents"]), "expenses": money(month["expense_cents"]), "net": money(month["net_cents"])},
            "ytd": {"income": money(ytd["income_cents"]), "expenses": money(ytd["expense_cents"]), "net": money(ytd["net_cents"])},
            "series": series,
            "overdue_invoices": [i.to_dict() for i in overdue[:6]],
            "bills_due": [b.to_dict() for b in bills_due[:6]],
            "recent_entries": [e.to_dict(with_lines=False) for e in recent],
            "bank_to_review": BankTransaction.query.filter_by(status="review").count(),
        }
    )
