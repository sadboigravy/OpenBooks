"""Invoices, estimates, sales receipts, payments received and products & services."""
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from flask import jsonify, request

from ..ledger import delete_entry, post_entry, system_account
from ..models import (
    SUBTYPE_AR,
    SUBTYPE_SALES_TAX,
    Account,
    Contact,
    Invoice,
    InvoiceLine,
    Item,
    JournalEntry,
    Payment,
    TimeEntry,
    db,
    money,
)
from ..util import ApiError, body, get_or_404, opt_str, parse_date, required_str, to_cents, to_decimal
from ..models import TaxCode
from .taxes import record_doc_tax, sales_tax_for
from . import bp

DEPOSIT_SUBTYPES = ("bank", "cash")
KINDS = ("invoice", "estimate", "sales_receipt")
KIND_LABEL = {"invoice": "Invoice", "estimate": "Estimate", "sales_receipt": "Sales receipt"}
NUMBERING = {
    "invoice": ("invoice_prefix", "next_invoice_number"),
    "estimate": ("estimate_prefix", "next_estimate_number"),
    "sales_receipt": ("receipt_prefix", "next_receipt_number"),
}


def _settings():
    from .settings import get_settings

    return get_settings()


def _peek_number(kind):
    """The next unused number for this kind of document (without reserving it)."""
    s = _settings()
    prefix_key, next_key = NUMBERING[kind]
    prefix, n = s.get(prefix_key, ""), int(s.get(next_key) or 1001)
    while Invoice.query.filter_by(number=f"{prefix}{n}").first():
        n += 1
    return prefix, n


def _next_number(kind):
    from .settings import set_setting

    prefix, n = _peek_number(kind)
    set_setting(NUMBERING[kind][1], n + 1)
    return f"{prefix}{n}"


def _deposit_account(account_id):
    account = db.session.get(Account, account_id)
    if account is None or account.subtype not in DEPOSIT_SUBTYPES:
        raise ApiError("Choose a bank or cash account to deposit into")
    return account


def _post_invoice(invoice):
    """(Re)create the ledger entry.

    Invoice:       Dr Accounts Receivable / Cr income (+ sales tax)
    Sales receipt: Dr deposit account     / Cr income (+ sales tax)
    Estimates, drafts and voided documents post nothing.
    """
    if invoice.kind == "estimate" or invoice.status in ("draft", "void"):
        delete_entry(invoice.journal_entry_id)
        invoice.journal_entry_id = None
        return
    label = f"{KIND_LABEL[invoice.kind]} {invoice.number}"
    debit_account = invoice.deposit_account_id if invoice.kind == "sales_receipt" else system_account(SUBTYPE_AR).id
    lines = [{"account_id": debit_account, "debit": invoice.total_cents, "description": label}]
    by_account = {}
    for line in invoice.lines:
        net = line.net_cents if line.net_cents is not None else line.amount_cents
        by_account[line.account_id] = by_account.get(line.account_id, 0) + net
    for account_id, amount in by_account.items():
        if amount > 0:
            lines.append({"account_id": account_id, "credit": amount, "description": label})
        elif amount < 0:
            lines.append({"account_id": account_id, "debit": -amount, "description": label})
    if invoice.tax_cents:
        lines.append({"account_id": system_account(SUBTYPE_SALES_TAX).id, "credit": invoice.tax_cents, "description": "Sales tax"})
    existing = db.session.get(JournalEntry, invoice.journal_entry_id) if invoice.journal_entry_id else None
    entry = post_entry(
        date=invoice.date,
        memo=f"{label} – {invoice.customer.name}",
        reference=invoice.number,
        source_type=invoice.kind,
        source_id=invoice.id,
        lines=lines,
        entry=existing,
    )
    invoice.journal_entry_id = entry.id


def _build_lines(raw_lines):
    new_lines, time_ids = [], []
    for raw in raw_lines or []:
        description = opt_str(raw, "description")
        qty = to_decimal(raw.get("quantity", 1))
        price_cents = to_cents(raw.get("unit_price"), "rate", allow_negative=True)
        item = db.session.get(Item, raw.get("item_id")) if raw.get("item_id") else None
        if not description and price_cents == 0 and item is None:
            continue  # blank row
        account_id = raw.get("account_id") or (item.income_account_id if item else None)
        account = db.session.get(Account, account_id) if account_id else None
        if account is None or account.type != "income":
            raise ApiError("Each line needs a product/service or an income account")
        amount = int((qty * price_cents).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        tax_code = None
        if raw.get("tax_code_id"):
            tax_code = db.session.get(TaxCode, raw.get("tax_code_id"))
            if tax_code is None:
                raise ApiError("Unknown tax code on a line")
        new_lines.append(
            InvoiceLine(
                account_id=account.id,
                item_id=item.id if item else None,
                description=description,
                quantity=float(qty),
                unit_price_cents=price_cents,
                amount_cents=amount,
                taxable=bool(raw.get("taxable", True)),
                tax_code_id=tax_code.id if tax_code else None,
                tax_code=tax_code,
            )
        )
        time_ids.extend(int(t) for t in (raw.get("time_entry_ids") or []))
    if not new_lines:
        raise ApiError("Add at least one line")
    return new_lines, time_ids


def save_invoice(data, invoice=None):
    creating = invoice is None
    kind = invoice.kind if invoice else (data.get("kind") or "invoice")
    if kind not in KINDS:
        raise ApiError("Unknown document type")
    customer = db.session.get(Contact, data.get("customer_id"))
    if customer is None or customer.kind != "customer":
        raise ApiError("Choose a customer")

    allowed = {"invoice": ("draft", "open"), "estimate": ("pending", "accepted", "rejected", "closed"), "sales_receipt": ("paid",)}[kind]
    default_status = invoice.status if invoice and invoice.status in allowed else allowed[0] if kind != "invoice" else "open"
    status = data.get("status") or default_status
    if status not in allowed:
        raise ApiError("Invalid status")

    doc_date = parse_date(data.get("date"), "date")
    terms = int(_settings().get("default_terms_days") or 30)
    if kind == "sales_receipt":
        due = doc_date
    else:
        due = parse_date(data.get("due_date"), "due date", required=False) or doc_date + timedelta(days=terms)
        if due < doc_date:
            raise ApiError(("The expiration date" if kind == "estimate" else "The due date") + " cannot be before the date")

    try:
        tax_rate = float(data.get("tax_rate") or 0)
    except (TypeError, ValueError):
        raise ApiError("Tax rate must be a number")
    if not 0 <= tax_rate <= 100:
        raise ApiError("Tax rate must be between 0 and 100")

    new_lines, time_ids = _build_lines(data.get("lines"))
    inclusive = bool(data.get("amounts_inclusive"))
    calc, source = sales_tax_for(customer, new_lines, inclusive=inclusive, legacy_rate=tax_rate, provider=data.get("tax_source"))
    for line, net, line_tax in zip(new_lines, calc.line_net, calc.line_tax):
        line.net_cents = net
        line.tax_cents = line_tax
    subtotal, tax = calc.subtotal_cents, calc.tax_cents
    if subtotal + tax <= 0:
        raise ApiError("The total must be greater than zero")

    deposit = _deposit_account(data.get("deposit_account_id")) if kind == "sales_receipt" else None

    if creating:
        invoice = Invoice(kind=kind)
    elif invoice.status == "void":
        raise ApiError(f"A voided {KIND_LABEL[kind].lower()} cannot be edited")
    if not creating and kind == "invoice":
        if subtotal + tax < invoice.paid_cents:
            raise ApiError("The new total is less than the payments already received")
        if status == "draft" and invoice.paid_cents:
            raise ApiError("An invoice with payments cannot be turned back into a draft")

    number = opt_str(data, "number")
    if number:
        clash = Invoice.query.filter(Invoice.number == number)
        if not creating:
            clash = clash.filter(Invoice.id != invoice.id)
        if clash.first():
            raise ApiError(f"Number {number} is already used")
        invoice.number = number
    elif creating:
        invoice.number = _next_number(kind)

    invoice.customer = customer
    invoice.customer_id = customer.id
    invoice.date = doc_date
    invoice.due_date = due
    invoice.status = status
    invoice.tax_rate = tax_rate
    invoice.memo = opt_str(data, "memo")
    invoice.method = opt_str(data, "method")
    invoice.reference = opt_str(data, "reference")
    invoice.deposit_account_id = deposit.id if deposit else None
    invoice.lines.clear()
    invoice.lines.extend(new_lines)
    invoice.subtotal_cents = subtotal
    invoice.tax_cents = tax
    invoice.amounts_inclusive = inclusive
    invoice.tax_source = source
    if source != "legacy":
        invoice.tax_rate = 0
    if creating:
        db.session.add(invoice)
    db.session.flush()

    # Link billable time that was pulled onto this document
    if kind != "estimate":
        for t in TimeEntry.query.filter_by(invoice_id=invoice.id).all():
            if t.id not in time_ids:
                t.invoice_id = None
        for tid in time_ids:
            t = db.session.get(TimeEntry, tid)
            if t is None or (t.invoice_id and t.invoice_id != invoice.id):
                raise ApiError("Some of that time has already been billed")
            if t.customer_id != customer.id:
                raise ApiError("Billable time must belong to the same customer")
            t.invoice_id = invoice.id

    # Invoice created from an estimate closes the estimate
    if creating and kind == "invoice" and data.get("estimate_id"):
        estimate = db.session.get(Invoice, data.get("estimate_id"))
        if estimate and estimate.kind == "estimate":
            estimate.status = "closed"
            estimate.estimate_id = invoice.id  # on an estimate, points at the invoice it became
            invoice.estimate_id = estimate.id

    _post_invoice(invoice)
    record_doc_tax(
        invoice,
        calc.details if kind != "estimate" and invoice.status not in ("draft", "void") else [],
        "sales",
        invoice.date,
    )
    db.session.flush()
    return invoice


def save_payment(invoice, data):
    if invoice.kind != "invoice":
        raise ApiError("Payments can only be recorded against invoices")
    if invoice.status == "draft":
        raise ApiError("Finalise the invoice before recording a payment")
    if invoice.status == "void":
        raise ApiError("This invoice has been voided")
    amount = to_cents(data.get("amount"), "payment amount", allow_zero=False)
    if amount > invoice.balance_cents:
        raise ApiError(f"The payment for {invoice.number} is more than its balance due ({invoice.balance_cents / 100:.2f})")
    account = _deposit_account(data.get("account_id"))
    payment = Payment(
        invoice_id=invoice.id,
        date=parse_date(data.get("date"), "payment date"),
        amount=amount,
        account_id=account.id,
        method=opt_str(data, "method"),
        reference=opt_str(data, "reference"),
    )
    db.session.add(payment)
    db.session.flush()
    entry = post_entry(
        date=payment.date,
        memo=f"Payment for invoice {invoice.number} – {invoice.customer.name}",
        reference=payment.reference or invoice.number,
        source_type="invoice_payment",
        source_id=payment.id,
        lines=[
            {"account_id": account.id, "debit": amount},
            {"account_id": system_account(SUBTYPE_AR).id, "credit": amount},
        ],
    )
    payment.journal_entry_id = entry.id
    db.session.flush()
    db.session.expire(invoice, ["payments"])
    return payment


# ---------------------------------------------------------------- invoices / estimates / receipts


@bp.get("/invoices")
def list_invoices():
    kind = request.args.get("kind", "invoice")
    q = Invoice.query
    if kind != "all":
        q = q.filter_by(kind=kind)
    if request.args.get("customer_id"):
        q = q.filter_by(customer_id=int(request.args["customer_id"]))
    docs = [i.to_dict() for i in q.order_by(Invoice.date.desc(), Invoice.id.desc()).all()]
    status = request.args.get("status")
    if status == "unpaid":
        docs = [i for i in docs if i["status"] in ("open", "partial", "overdue")]
    elif status == "not_due":
        docs = [i for i in docs if i["status"] in ("open", "partial")]
    elif status:
        docs = [i for i in docs if i["status"] == status]
    return jsonify(docs)


@bp.get("/invoices/next-number")
def next_invoice_number():
    prefix, n = _peek_number(request.args.get("kind", "invoice"))
    return jsonify({"number": f"{prefix}{n}"})


@bp.get("/invoices/<int:invoice_id>")
def get_invoice(invoice_id):
    invoice = get_or_404(Invoice, invoice_id, "Document")
    d = invoice.to_dict(full=True)
    d["time_entry_ids"] = [t.id for t in TimeEntry.query.filter_by(invoice_id=invoice.id).all()]
    return jsonify(d)


@bp.post("/invoices")
def create_invoice():
    invoice = save_invoice(body())
    db.session.commit()
    return jsonify(invoice.to_dict(full=True)), 201


@bp.put("/invoices/<int:invoice_id>")
def update_invoice(invoice_id):
    invoice = save_invoice(body(), get_or_404(Invoice, invoice_id, "Document"))
    db.session.commit()
    return jsonify(invoice.to_dict(full=True))


@bp.post("/invoices/<int:invoice_id>/void")
def void_invoice(invoice_id):
    invoice = get_or_404(Invoice, invoice_id, "Document")
    if invoice.kind == "estimate":
        raise ApiError("Estimates are not posted to the books. Mark it rejected or delete it instead.")
    if invoice.payments:
        raise ApiError("Delete the payments on this invoice before voiding it")
    invoice.status = "void"
    _post_invoice(invoice)
    record_doc_tax(invoice, [], "sales", invoice.date)
    TimeEntry.query.filter_by(invoice_id=invoice.id).update({"invoice_id": None})
    db.session.commit()
    return jsonify(invoice.to_dict(full=True))


@bp.post("/invoices/<int:invoice_id>/status")
def set_estimate_status(invoice_id):
    estimate = get_or_404(Invoice, invoice_id, "Estimate")
    if estimate.kind != "estimate":
        raise ApiError("Only estimates have an acceptance status")
    status = body().get("status")
    if status not in ("pending", "accepted", "rejected"):
        raise ApiError("Invalid status")
    if estimate.status == "closed":
        raise ApiError("This estimate has already been converted to an invoice")
    estimate.status = status
    db.session.commit()
    return jsonify(estimate.to_dict(full=True))


@bp.delete("/invoices/<int:invoice_id>")
def delete_invoice(invoice_id):
    invoice = get_or_404(Invoice, invoice_id, "Document")
    if invoice.kind == "invoice" and invoice.status not in ("draft", "void"):
        raise ApiError("Only draft or voided invoices can be deleted. Void it first.")
    delete_entry(invoice.journal_entry_id)
    record_doc_tax(invoice, [], "sales", invoice.date)
    TimeEntry.query.filter_by(invoice_id=invoice.id).update({"invoice_id": None})
    if invoice.kind == "invoice" and invoice.estimate_id:
        estimate = db.session.get(Invoice, invoice.estimate_id)
        if estimate and estimate.kind == "estimate":
            estimate.status = "accepted"
            estimate.estimate_id = None
    db.session.delete(invoice)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- payments


@bp.post("/invoices/<int:invoice_id>/payments")
def receive_payment(invoice_id):
    invoice = get_or_404(Invoice, invoice_id, "Invoice")
    save_payment(invoice, body())
    db.session.commit()
    return jsonify(invoice.to_dict(full=True)), 201


@bp.post("/payments/receive")
def receive_payment_multi():
    """Receive one customer payment and apply it across several open invoices."""
    data = body()
    applications = [a for a in (data.get("applications") or []) if to_cents(a.get("amount"), "amount") > 0]
    if not applications:
        raise ApiError("Enter an amount against at least one invoice")
    customer_id = data.get("customer_id")
    created = []
    for app_ in applications:
        invoice = get_or_404(Invoice, app_.get("invoice_id"), "Invoice")
        if customer_id and invoice.customer_id != int(customer_id):
            raise ApiError("All invoices must belong to the selected customer")
        created.append(
            save_payment(
                invoice,
                {**data, "amount": app_.get("amount")},
            )
        )
    db.session.commit()
    return jsonify({"payments": [p.to_dict() for p in created], "total": money(sum(p.amount for p in created))}), 201


@bp.delete("/payments/<int:payment_id>")
def delete_payment(payment_id):
    payment = get_or_404(Payment, payment_id, "Payment")
    delete_entry(payment.journal_entry_id)
    db.session.delete(payment)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- all sales & money bar


@bp.get("/sales/transactions")
def sales_transactions():
    customer_id = request.args.get("customer_id", type=int)
    rows = []
    q = Invoice.query
    if customer_id:
        q = q.filter_by(customer_id=customer_id)
    for d in q.all():
        rows.append(
            {
                "type": d.kind,
                "id": d.id,
                "date": d.date.isoformat(),
                "number": d.number,
                "customer_id": d.customer_id,
                "customer": d.customer.name,
                "due_date": d.due_date.isoformat() if d.kind == "invoice" else None,
                "total": money(d.total_cents),
                "balance": money(d.balance_cents),
                "status": d.display_status,
            }
        )
    pq = Payment.query.filter(Payment.invoice_id.isnot(None)).join(Invoice, Payment.invoice_id == Invoice.id)
    if customer_id:
        pq = pq.filter(Invoice.customer_id == customer_id)
    for p in pq.all():
        inv = db.session.get(Invoice, p.invoice_id)
        rows.append(
            {
                "type": "payment",
                "id": p.id,
                "invoice_id": inv.id,
                "date": p.date.isoformat(),
                "number": p.reference,
                "customer_id": inv.customer_id,
                "customer": inv.customer.name,
                "due_date": None,
                "total": money(-p.amount),
                "balance": 0,
                "status": "closed",
                "memo": f"Applied to {inv.number}",
            }
        )
    rows.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    return jsonify(rows)


@bp.get("/sales/summary")
def sales_summary():
    today = date.today()
    since = today - timedelta(days=30)
    invoices = Invoice.query.filter_by(kind="invoice", status="open").all()
    overdue = [i for i in invoices if i.balance_cents > 0 and i.due_date < today]
    not_due = [i for i in invoices if i.balance_cents > 0 and i.due_date >= today]
    estimates = Invoice.query.filter_by(kind="estimate").filter(Invoice.status.in_(("pending", "accepted"))).all()
    payments = Payment.query.filter(Payment.invoice_id.isnot(None), Payment.date >= since).all()
    receipts = Invoice.query.filter_by(kind="sales_receipt", status="paid").filter(Invoice.date >= since).all()
    return jsonify(
        {
            "estimates": {"count": len(estimates), "total": money(sum(e.total_cents for e in estimates))},
            "overdue": {"count": len(overdue), "total": money(sum(i.balance_cents for i in overdue))},
            "not_due": {"count": len(not_due), "total": money(sum(i.balance_cents for i in not_due))},
            "paid": {
                "count": len(payments) + len(receipts),
                "total": money(sum(p.amount for p in payments) + sum(r.total_cents for r in receipts)),
            },
        }
    )


# ---------------------------------------------------------------- products & services


def _apply_item(item, data, creating):
    name = required_str(data, "name")
    clash = Item.query.filter(Item.name == name)
    if not creating:
        clash = clash.filter(Item.id != item.id)
    if clash.first():
        raise ApiError(f"A product or service called '{name}' already exists")
    income = db.session.get(Account, data.get("income_account_id"))
    if income is None or income.type != "income":
        raise ApiError("Choose an income account")
    expense = None
    if data.get("expense_account_id"):
        expense = db.session.get(Account, data.get("expense_account_id"))
        if expense is None or expense.type not in ("expense", "asset"):
            raise ApiError("Choose an expense account")
    type_ = data.get("type") or "service"
    if type_ not in ("service", "non_inventory"):
        raise ApiError("Invalid type")
    item.name = name
    item.type = type_
    item.sku = opt_str(data, "sku")
    item.description = opt_str(data, "description")
    item.price_cents = to_cents(data.get("price"), "price")
    item.cost_cents = to_cents(data.get("cost"), "cost")
    item.income_account_id = income.id
    item.expense_account_id = expense.id if expense else None
    item.taxable = bool(data.get("taxable", True))
    for key in ("sales_tax_code_id", "purchase_tax_code_id"):
        if key in data:
            code_id = data.get(key) or None
            if code_id and db.session.get(TaxCode, code_id) is None:
                raise ApiError("Unknown tax code")
            setattr(item, key, code_id)
    if "stripe_tax_code" in data:
        item.stripe_tax_code = opt_str(data, "stripe_tax_code")
    if "active" in data:
        item.active = bool(data["active"])


@bp.get("/items")
def list_items():
    q = Item.query
    if request.args.get("include_inactive") != "1":
        q = q.filter_by(active=True)
    return jsonify([i.to_dict() for i in q.order_by(Item.name).all()])


@bp.post("/items")
def create_item():
    item = Item()
    _apply_item(item, body(), True)
    db.session.add(item)
    db.session.commit()
    return jsonify(item.to_dict()), 201


@bp.put("/items/<int:item_id>")
def update_item(item_id):
    item = get_or_404(Item, item_id, "Product or service")
    _apply_item(item, body(), False)
    db.session.commit()
    return jsonify(item.to_dict())


@bp.delete("/items/<int:item_id>")
def delete_item(item_id):
    item = get_or_404(Item, item_id, "Product or service")
    if InvoiceLine.query.filter_by(item_id=item.id).first() or TimeEntry.query.filter_by(item_id=item.id).first():
        raise ApiError("This item is used on transactions. Make it inactive instead.")
    db.session.delete(item)
    db.session.commit()
    return jsonify({"ok": True})
