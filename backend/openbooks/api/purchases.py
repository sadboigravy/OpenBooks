from datetime import timedelta

from flask import jsonify, request

from ..ledger import delete_entry, post_entry, system_account
from ..models import SUBTYPE_AP, SUBTYPE_SALES_TAX, Account, Bill, BillLine, Contact, Expense, ExpenseLine, JournalEntry, Payment, TaxCode, db
from ..util import ApiError, body, get_or_404, opt_str, parse_date, to_cents
from .taxes import purchase_tax_for, record_doc_tax
from . import bp

PAY_FROM_SUBTYPES = ("bank", "cash", "credit_card")
CATEGORY_TYPES = ("expense", "asset", "liability", "equity")


def _category_lines(raw_lines, line_model):
    lines = []
    for raw in raw_lines or []:
        description = opt_str(raw, "description")
        amount = to_cents(raw.get("amount"), "amount", allow_negative=True)
        if amount == 0 and not description:
            continue
        account = db.session.get(Account, raw.get("account_id"))
        if account is None or account.type not in CATEGORY_TYPES:
            raise ApiError("Each line needs an expense (or asset) category")
        if account.subtype in ("accounts_payable", "accounts_receivable"):
            raise ApiError("Choose a category other than A/R or A/P")
        tax_code = None
        if raw.get("tax_code_id"):
            tax_code = db.session.get(TaxCode, raw.get("tax_code_id"))
            if tax_code is None:
                raise ApiError("Unknown tax code on a line")
        line = line_model(account_id=account.id, description=description, amount_cents=amount, tax_code_id=tax_code.id if tax_code else None)
        line.tax_code = tax_code
        lines.append(line)
    if not lines:
        raise ApiError("Add at least one line")
    if sum(l.amount_cents for l in lines) <= 0:
        raise ApiError("The total must be greater than zero")
    return lines


def _existing_entry(entry_id):
    return db.session.get(JournalEntry, entry_id) if entry_id else None


def _apply_tax(lines, inclusive):
    """Work out recoverable purchase tax (VAT/GST input tax) and store net/tax on each line."""
    calc = purchase_tax_for(lines, inclusive=inclusive)
    for line, net, tax in zip(lines, calc.line_net, calc.line_tax):
        line.net_cents = net
        line.tax_cents = tax or 0
    return calc


def _debits_and_credit(lines, credit_account_id, label, tax_cents=0):
    """Debit each category (net of tax), debit recoverable tax, credit the source account.

    Negative lines (refunds/discounts) flip sides.
    """
    out = []
    for l in lines:
        net = l.net_cents if l.net_cents is not None else l.amount_cents
        if net >= 0:
            out.append({"account_id": l.account_id, "debit": net, "description": l.description or label})
        else:
            out.append({"account_id": l.account_id, "credit": -net, "description": l.description or label})
    if tax_cents:
        tax_account = system_account(SUBTYPE_SALES_TAX).id
        out.append({"account_id": tax_account, "debit" if tax_cents > 0 else "credit": abs(tax_cents), "description": "Recoverable tax"})
    total = sum((l.net_cents if l.net_cents is not None else l.amount_cents) for l in lines) + tax_cents
    out.append({"account_id": credit_account_id, "credit": total, "description": label})
    return out


# ---------------------------------------------------------------- bills


def save_bill(data, bill=None):
    creating = bill is None
    vendor = db.session.get(Contact, data.get("vendor_id"))
    if vendor is None or vendor.kind != "vendor":
        raise ApiError("Choose a vendor")
    bill_date = parse_date(data.get("date"), "bill date")
    due = parse_date(data.get("due_date"), "due date", required=False) or bill_date + timedelta(days=30)
    if due < bill_date:
        raise ApiError("The due date cannot be before the bill date")
    lines = _category_lines(data.get("lines"), BillLine)
    inclusive = bool(data.get("amounts_inclusive"))
    calc = _apply_tax(lines, inclusive)
    total = calc.total_cents

    if creating:
        bill = Bill()
    else:
        if bill.status == "void":
            raise ApiError("A voided bill cannot be edited")
        if total < bill.paid_cents:
            raise ApiError("The new total is less than the payments already made")

    bill.vendor = vendor
    bill.vendor_id = vendor.id
    bill.number = opt_str(data, "number")
    bill.date = bill_date
    bill.due_date = due
    bill.memo = opt_str(data, "memo")
    bill.lines.clear()
    bill.lines.extend(lines)
    bill.total_cents = total
    bill.tax_cents = calc.tax_cents
    bill.amounts_inclusive = inclusive
    if creating:
        db.session.add(bill)
    db.session.flush()

    label = f"Bill {bill.number}".strip() if bill.number else f"Bill from {vendor.name}"
    entry = post_entry(
        date=bill.date,
        memo=f"{label} – {vendor.name}" if bill.number else label,
        reference=bill.number,
        source_type="bill",
        source_id=bill.id,
        lines=_debits_and_credit(bill.lines, system_account(SUBTYPE_AP).id, label, calc.tax_cents),
        entry=_existing_entry(bill.journal_entry_id),
    )
    bill.journal_entry_id = entry.id
    record_doc_tax(bill, calc.details, "purchases", bill.date)
    db.session.flush()
    return bill


def save_bill_payment(bill, data):
    if bill.status == "void":
        raise ApiError("This bill has been voided")
    amount = to_cents(data.get("amount"), "payment amount", allow_zero=False)
    if amount > bill.balance_cents:
        raise ApiError(f"The payment is more than the balance due ({bill.balance_cents / 100:.2f})")
    account = db.session.get(Account, data.get("account_id"))
    if account is None or account.subtype not in PAY_FROM_SUBTYPES:
        raise ApiError("Choose a bank, cash or credit card account to pay from")
    payment = Payment(
        bill_id=bill.id,
        date=parse_date(data.get("date"), "payment date"),
        amount=amount,
        account_id=account.id,
        method=opt_str(data, "method"),
        reference=opt_str(data, "reference"),
    )
    db.session.add(payment)
    db.session.flush()
    ap = system_account(SUBTYPE_AP)
    entry = post_entry(
        date=payment.date,
        memo=f"Bill payment – {bill.vendor.name}",
        reference=payment.reference or bill.number,
        source_type="bill_payment",
        source_id=payment.id,
        lines=[
            {"account_id": ap.id, "debit": amount},
            {"account_id": account.id, "credit": amount},
        ],
    )
    payment.journal_entry_id = entry.id
    db.session.flush()
    db.session.expire(bill, ["payments"])
    return payment


@bp.get("/bills")
def list_bills():
    q = Bill.query
    if request.args.get("vendor_id"):
        q = q.filter_by(vendor_id=int(request.args["vendor_id"]))
    bills = [b.to_dict() for b in q.order_by(Bill.due_date.desc(), Bill.id.desc()).all()]
    status = request.args.get("status")
    if status == "unpaid":
        bills = [b for b in bills if b["status"] in ("open", "partial", "overdue")]
    elif status:
        bills = [b for b in bills if b["status"] == status]
    return jsonify(bills)


@bp.get("/bills/<int:bill_id>")
def get_bill(bill_id):
    return jsonify(get_or_404(Bill, bill_id, "Bill").to_dict(full=True))


@bp.post("/bills")
def create_bill():
    bill = save_bill(body())
    db.session.commit()
    return jsonify(bill.to_dict(full=True)), 201


@bp.put("/bills/<int:bill_id>")
def update_bill(bill_id):
    bill = save_bill(body(), get_or_404(Bill, bill_id, "Bill"))
    db.session.commit()
    return jsonify(bill.to_dict(full=True))


@bp.post("/bills/<int:bill_id>/void")
def void_bill(bill_id):
    bill = get_or_404(Bill, bill_id, "Bill")
    if bill.payments:
        raise ApiError("Delete the payments on this bill before voiding it")
    bill.status = "void"
    record_doc_tax(bill, [], "purchases", bill.date)
    delete_entry(bill.journal_entry_id)
    bill.journal_entry_id = None
    db.session.commit()
    return jsonify(bill.to_dict(full=True))


@bp.delete("/bills/<int:bill_id>")
def delete_bill(bill_id):
    bill = get_or_404(Bill, bill_id, "Bill")
    if bill.payments:
        raise ApiError("Delete the payments on this bill first")
    record_doc_tax(bill, [], "purchases", bill.date)
    delete_entry(bill.journal_entry_id)
    db.session.delete(bill)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/bills/<int:bill_id>/payments")
def pay_bill(bill_id):
    bill = get_or_404(Bill, bill_id, "Bill")
    save_bill_payment(bill, body())
    db.session.commit()
    return jsonify(bill.to_dict(full=True)), 201


# ---------------------------------------------------------------- expenses


def save_expense(data, expense=None):
    creating = expense is None
    if creating:
        expense = Expense()
    vendor = None
    if data.get("vendor_id"):
        vendor = db.session.get(Contact, data.get("vendor_id"))
        if vendor is None or vendor.kind != "vendor":
            raise ApiError("Vendor not found")
    payee = opt_str(data, "payee")
    if vendor is None and not payee:
        raise ApiError("Choose a vendor or enter a payee")
    account = db.session.get(Account, data.get("account_id"))
    if account is None or account.subtype not in PAY_FROM_SUBTYPES:
        raise ApiError("Choose the bank, cash or credit card account this was paid from")
    lines = _category_lines(data.get("lines"), ExpenseLine)
    inclusive = bool(data.get("amounts_inclusive"))
    calc = _apply_tax(lines, inclusive)

    expense.date = parse_date(data.get("date"), "payment date")
    expense.vendor_id = vendor.id if vendor else None
    expense.vendor = vendor
    expense.payee = payee
    expense.account_id = account.id
    expense.account = account
    expense.method = opt_str(data, "method")
    expense.reference = opt_str(data, "reference")
    expense.memo = opt_str(data, "memo")
    expense.lines.clear()
    expense.lines.extend(lines)
    expense.total_cents = calc.total_cents
    expense.tax_cents = calc.tax_cents
    expense.amounts_inclusive = inclusive
    if creating:
        db.session.add(expense)
    db.session.flush()

    name = vendor.name if vendor else payee
    entry = post_entry(
        date=expense.date,
        memo=f"Expense – {name}" + (f": {expense.memo}" if expense.memo else ""),
        reference=expense.reference,
        source_type="expense",
        source_id=expense.id,
        lines=_debits_and_credit(expense.lines, account.id, f"Expense – {name}", calc.tax_cents),
        entry=_existing_entry(expense.journal_entry_id),
    )
    expense.journal_entry_id = entry.id
    record_doc_tax(expense, calc.details, "purchases", expense.date)
    db.session.flush()
    return expense


@bp.get("/expenses")
def list_expenses():
    q = Expense.query
    if request.args.get("vendor_id"):
        q = q.filter_by(vendor_id=int(request.args["vendor_id"]))
    return jsonify([e.to_dict() for e in q.order_by(Expense.date.desc(), Expense.id.desc()).all()])


@bp.get("/expenses/<int:expense_id>")
def get_expense(expense_id):
    return jsonify(get_or_404(Expense, expense_id, "Expense").to_dict())


@bp.post("/expenses")
def create_expense():
    expense = save_expense(body())
    db.session.commit()
    return jsonify(expense.to_dict()), 201


@bp.put("/expenses/<int:expense_id>")
def update_expense(expense_id):
    expense = save_expense(body(), get_or_404(Expense, expense_id, "Expense"))
    db.session.commit()
    return jsonify(expense.to_dict())


@bp.delete("/expenses/<int:expense_id>")
def delete_expense(expense_id):
    expense = get_or_404(Expense, expense_id, "Expense")
    record_doc_tax(expense, [], "purchases", expense.date)
    delete_entry(expense.journal_entry_id)
    db.session.delete(expense)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- pay several bills at once


@bp.post("/bills/pay")
def pay_bills():
    data = body()
    applications = [a for a in (data.get("applications") or []) if to_cents(a.get("amount"), "amount") > 0]
    if not applications:
        raise ApiError("Select at least one bill and enter a payment amount")
    created = []
    for app_ in applications:
        bill = get_or_404(Bill, app_.get("bill_id"), "Bill")
        payload = {**data, "amount": app_.get("amount")}
        if app_.get("reference"):
            payload["reference"] = app_["reference"]
        created.append(save_bill_payment(bill, payload))
    db.session.commit()
    return jsonify({"paid": len(created), "total": sum(p.amount for p in created) / 100}), 201


# ---------------------------------------------------------------- combined list & money bar


@bp.get("/purchases/transactions")
def purchase_transactions():
    from ..models import money

    vendor_id = request.args.get("vendor_id", type=int)
    rows = []
    eq = Expense.query
    bq = Bill.query
    if vendor_id:
        eq = eq.filter_by(vendor_id=vendor_id)
        bq = bq.filter_by(vendor_id=vendor_id)
    for e in eq.all():
        rows.append(
            {
                "type": "check" if e.method == "Check" else "expense",
                "id": e.id,
                "date": e.date.isoformat(),
                "number": e.reference,
                "payee": e.vendor.name if e.vendor else e.payee,
                "vendor_id": e.vendor_id,
                "category": ", ".join(sorted({l.account.name for l in e.lines})),
                "total": money(e.total_cents),
                "balance": 0,
                "status": "paid",
                "memo": e.memo,
            }
        )
    for b in bq.all():
        rows.append(
            {
                "type": "bill",
                "id": b.id,
                "date": b.date.isoformat(),
                "due_date": b.due_date.isoformat(),
                "number": b.number,
                "payee": b.vendor.name,
                "vendor_id": b.vendor_id,
                "category": ", ".join(sorted({l.account.name for l in b.lines})),
                "total": money(b.total_cents),
                "balance": money(b.balance_cents),
                "status": b.display_status,
                "memo": b.memo,
            }
        )
        for p in b.payments:
            rows.append(
                {
                    "type": "bill_payment",
                    "id": p.id,
                    "bill_id": b.id,
                    "date": p.date.isoformat(),
                    "number": p.reference,
                    "payee": b.vendor.name,
                    "vendor_id": b.vendor_id,
                    "category": p.account.name,
                    "total": money(p.amount),
                    "balance": 0,
                    "status": "paid",
                    "memo": f"Payment for bill {b.number}".strip(),
                }
            )
    rows.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    return jsonify(rows)


@bp.get("/purchases/summary")
def purchases_summary():
    from datetime import date as _date

    from ..models import money

    today = _date.today()
    since = today - timedelta(days=30)
    bills = [b for b in Bill.query.filter_by(status="open").all() if b.balance_cents > 0]
    overdue = [b for b in bills if b.due_date < today]
    not_due = [b for b in bills if b.due_date >= today]
    paid = Payment.query.filter(Payment.bill_id.isnot(None), Payment.date >= since).all()
    return jsonify(
        {
            "overdue": {"count": len(overdue), "total": money(sum(b.balance_cents for b in overdue))},
            "not_due": {"count": len(not_due), "total": money(sum(b.balance_cents for b in not_due))},
            "paid": {"count": len(paid), "total": money(sum(p.amount for p in paid))},
        }
    )
