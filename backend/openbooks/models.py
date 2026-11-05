"""Database models.

All money is stored as integer cents to avoid floating point rounding errors.
"""
from datetime import date, datetime, timezone

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

ACCOUNT_TYPES = ("asset", "liability", "equity", "income", "expense")
DEBIT_NORMAL_TYPES = ("asset", "expense")

# Account subtypes with special meaning in the app
BANK_SUBTYPES = ("bank", "cash", "credit_card")
SUBTYPE_AR = "accounts_receivable"
SUBTYPE_AP = "accounts_payable"
SUBTYPE_SALES_TAX = "sales_tax"
SUBTYPE_RETAINED = "retained_earnings"
SUBTYPE_COGS = "cost_of_goods_sold"

ROLES = ("admin", "accountant", "viewer")


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def money(cents):
    """Convert integer cents to a JSON-friendly decimal number."""
    return round((cents or 0) / 100.0, 2)


def iso(d):
    return d.isoformat() if d else None


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    name = db.Column(db.String(255), nullable=False, default="")
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="accountant")
    active = db.Column(db.Boolean, nullable=False, default=True)
    created_at = db.Column(db.DateTime, default=_utcnow)
    # The built-in first-run login. It can only be used to create a real admin, then it is deleted.
    is_bootstrap = db.Column(db.Boolean, nullable=False, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "setup_required": self.is_bootstrap,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "active": self.active,
            "created_at": iso(self.created_at),
        }


class Setting(db.Model):
    key = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.Text, nullable=False, default="")


class Account(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(20), unique=True, nullable=False)
    name = db.Column(db.String(255), nullable=False)
    type = db.Column(db.String(20), nullable=False)
    subtype = db.Column(db.String(40), nullable=False, default="other")
    description = db.Column(db.Text, nullable=False, default="")
    is_system = db.Column(db.Boolean, nullable=False, default=False)
    active = db.Column(db.Boolean, nullable=False, default=True)

    @property
    def label(self):
        return f"{self.code} · {self.name}"

    @property
    def debit_normal(self):
        return self.type in DEBIT_NORMAL_TYPES

    def to_dict(self, balance_cents=None):
        d = {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "type": self.type,
            "subtype": self.subtype,
            "description": self.description,
            "is_system": self.is_system,
            "active": self.active,
            "label": self.label,
        }
        if balance_cents is not None:
            d["balance"] = money(balance_cents)
        return d


class JournalEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False, default=date.today)
    memo = db.Column(db.Text, nullable=False, default="")
    reference = db.Column(db.String(64), nullable=False, default="")
    # manual, invoice, invoice_payment, bill, bill_payment, expense, bank
    source_type = db.Column(db.String(32), nullable=False, default="manual")
    source_id = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=_utcnow)
    lines = db.relationship(
        "JournalLine",
        backref="entry",
        cascade="all, delete-orphan",
        order_by="JournalLine.id",
    )

    @property
    def total_cents(self):
        return sum(l.debit for l in self.lines)

    def to_dict(self, with_lines=True):
        d = {
            "id": self.id,
            "date": iso(self.date),
            "memo": self.memo,
            "reference": self.reference,
            "source_type": self.source_type,
            "source_id": self.source_id,
            "total": money(self.total_cents),
        }
        if with_lines:
            d["lines"] = [l.to_dict() for l in self.lines]
        return d


class JournalLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=False, index=True)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False, index=True)
    debit = db.Column(db.Integer, nullable=False, default=0)
    credit = db.Column(db.Integer, nullable=False, default=0)
    description = db.Column(db.Text, nullable=False, default="")
    reconciliation_id = db.Column(db.Integer, db.ForeignKey("reconciliation.id"), nullable=True, index=True)
    account = db.relationship("Account")

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "account": self.account.label,
            "reconciled": self.reconciliation_id is not None,
            "debit": money(self.debit),
            "credit": money(self.credit),
            "description": self.description,
        }


class Contact(db.Model):
    """A customer or a vendor."""

    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(16), nullable=False, index=True)  # customer | vendor
    name = db.Column(db.String(255), nullable=False)
    company = db.Column(db.String(255), nullable=False, default="")
    email = db.Column(db.String(255), nullable=False, default="")
    phone = db.Column(db.String(64), nullable=False, default="")
    address = db.Column(db.Text, nullable=False, default="")
    notes = db.Column(db.Text, nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)
    created_at = db.Column(db.DateTime, default=_utcnow)
    # structured address (used for automatic tax calculation)
    address_line1 = db.Column(db.String(255), nullable=False, default="")
    city = db.Column(db.String(128), nullable=False, default="")
    region = db.Column(db.String(64), nullable=False, default="")  # state / province / county
    postal_code = db.Column(db.String(32), nullable=False, default="")
    country = db.Column(db.String(2), nullable=False, default="")  # ISO 3166-1 alpha-2
    tax_exempt = db.Column(db.Boolean, nullable=False, default=False)
    exemption_reason = db.Column(db.String(255), nullable=False, default="")
    default_tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "address_line1": self.address_line1,
            "city": self.city,
            "region": self.region,
            "postal_code": self.postal_code,
            "country": self.country,
            "tax_exempt": self.tax_exempt,
            "exemption_reason": self.exemption_reason,
            "default_tax_code_id": self.default_tax_code_id,
            "name": self.name,
            "company": self.company,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "notes": self.notes,
            "active": self.active,
        }


class _PayableDoc:
    """Shared behaviour for invoices and bills."""

    @property
    def paid_cents(self):
        return sum(p.amount for p in self.payments)

    @property
    def balance_cents(self):
        if self.status in ("void", "draft"):
            return 0
        return self.total_cents - self.paid_cents

    @property
    def display_status(self):
        if self.status in ("void", "draft"):
            return self.status
        if self.balance_cents <= 0:
            return "paid"
        if self.due_date and self.due_date < date.today():
            return "overdue"
        if self.paid_cents > 0:
            return "partial"
        return "open"


class Invoice(db.Model, _PayableDoc):
    id = db.Column(db.Integer, primary_key=True)
    number = db.Column(db.String(32), unique=True, nullable=False)
    customer_id = db.Column(db.Integer, db.ForeignKey("contact.id"), nullable=False)
    date = db.Column(db.Date, nullable=False)
    due_date = db.Column(db.Date, nullable=False)
    # invoice: draft | open | void
    # estimate: pending | accepted | rejected | closed
    # sales_receipt: paid | void
    status = db.Column(db.String(16), nullable=False, default="open")
    kind = db.Column(db.String(16), nullable=False, default="invoice", index=True)
    deposit_account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=True)  # sales receipts
    method = db.Column(db.String(32), nullable=False, default="")
    reference = db.Column(db.String(64), nullable=False, default="")
    estimate_id = db.Column(db.Integer, nullable=True)  # invoice created from this estimate
    pay_token = db.Column(db.String(64), nullable=True, unique=True)  # public "pay online" link
    amounts_inclusive = db.Column(db.Boolean, nullable=False, default=False)  # line amounts include tax
    tax_source = db.Column(db.String(16), nullable=False, default="codes")  # codes | stripe | legacy
    tax_rate = db.Column(db.Float, nullable=False, default=0.0)  # percent
    subtotal_cents = db.Column(db.Integer, nullable=False, default=0)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    memo = db.Column(db.Text, nullable=False, default="")
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=_utcnow)

    customer = db.relationship("Contact")
    deposit_account = db.relationship("Account", foreign_keys=[deposit_account_id])
    lines = db.relationship("InvoiceLine", cascade="all, delete-orphan", order_by="InvoiceLine.id")
    payments = db.relationship(
        "Payment",
        primaryjoin="Payment.invoice_id == Invoice.id",
        order_by="Payment.date",
        viewonly=True,
    )

    @property
    def total_cents(self):
        return self.subtotal_cents + self.tax_cents

    @property
    def paid_cents(self):
        if self.kind == "sales_receipt":
            return 0 if self.status == "void" else self.total_cents
        if self.kind == "estimate":
            return 0
        return sum(p.amount for p in self.payments)

    @property
    def balance_cents(self):
        if self.kind != "invoice" or self.status in ("void", "draft"):
            return 0
        return self.total_cents - self.paid_cents

    @property
    def display_status(self):
        if self.kind == "estimate":
            if self.status == "pending" and self.due_date and self.due_date < date.today():
                return "expired"
            return self.status
        if self.kind == "sales_receipt":
            return "void" if self.status == "void" else "paid"
        return _PayableDoc.display_status.fget(self)

    def to_dict(self, full=False):
        d = {
            "id": self.id,
            "kind": self.kind,
            "number": self.number,
            "customer_id": self.customer_id,
            "customer": self.customer.name,
            "date": iso(self.date),
            "due_date": iso(self.due_date),
            "status": self.display_status,
            "tax_rate": self.tax_rate,
            "subtotal": money(self.subtotal_cents),
            "tax": money(self.tax_cents),
            "total": money(self.total_cents),
            "paid": money(self.paid_cents),
            "balance": money(self.balance_cents),
            "memo": self.memo,
            "deposit_account_id": self.deposit_account_id,
            "deposit_account": self.deposit_account.label if self.deposit_account else None,
            "method": self.method,
            "reference": self.reference,
            "estimate_id": self.estimate_id,
            "has_pay_link": bool(self.pay_token),
            "amounts_inclusive": self.amounts_inclusive,
            "tax_source": self.tax_source,
        }
        if full:
            d["customer_detail"] = self.customer.to_dict()
            d["lines"] = [l.to_dict() for l in self.lines]
            d["payments"] = [p.to_dict() for p in self.payments]
            d["journal_entry_id"] = self.journal_entry_id
            d["tax_details"] = [t.to_dict() for t in DocTax.query.filter_by(invoice_id=self.id).all()]
        return d


class InvoiceLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=True)
    description = db.Column(db.Text, nullable=False, default="")
    quantity = db.Column(db.Float, nullable=False, default=1)
    unit_price_cents = db.Column(db.Integer, nullable=False, default=0)
    amount_cents = db.Column(db.Integer, nullable=False, default=0)  # qty × rate as entered
    net_cents = db.Column(db.Integer, nullable=True)  # amount excluding tax (differs when prices include tax)
    taxable = db.Column(db.Boolean, nullable=False, default=True)  # legacy flat-rate documents
    tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    account = db.relationship("Account")
    item = db.relationship("Item")
    tax_code = db.relationship("TaxCode")

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "account": self.account.label,
            "item_id": self.item_id,
            "item": self.item.name if self.item else None,
            "description": self.description,
            "quantity": self.quantity,
            "unit_price": money(self.unit_price_cents),
            "amount": money(self.amount_cents),
            "taxable": self.taxable,
            "tax_code_id": self.tax_code_id,
            "tax_code": self.tax_code.name if self.tax_code else None,
            "tax": money(self.tax_cents),
        }


class Bill(db.Model, _PayableDoc):
    id = db.Column(db.Integer, primary_key=True)
    number = db.Column(db.String(64), nullable=False, default="")  # vendor's reference number
    vendor_id = db.Column(db.Integer, db.ForeignKey("contact.id"), nullable=False)
    date = db.Column(db.Date, nullable=False)
    due_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(16), nullable=False, default="open")  # open | void
    total_cents = db.Column(db.Integer, nullable=False, default=0)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)  # recoverable input tax included in total
    amounts_inclusive = db.Column(db.Boolean, nullable=False, default=False)
    memo = db.Column(db.Text, nullable=False, default="")
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=_utcnow)

    vendor = db.relationship("Contact")
    lines = db.relationship("BillLine", cascade="all, delete-orphan", order_by="BillLine.id")
    payments = db.relationship(
        "Payment",
        primaryjoin="Payment.bill_id == Bill.id",
        order_by="Payment.date",
        viewonly=True,
    )

    def to_dict(self, full=False):
        d = {
            "id": self.id,
            "number": self.number,
            "vendor_id": self.vendor_id,
            "vendor": self.vendor.name,
            "date": iso(self.date),
            "due_date": iso(self.due_date),
            "status": self.display_status,
            "total": money(self.total_cents),
            "tax": money(self.tax_cents),
            "amounts_inclusive": self.amounts_inclusive,
            "paid": money(self.paid_cents),
            "balance": money(self.balance_cents),
            "memo": self.memo,
        }
        if full:
            d["vendor_detail"] = self.vendor.to_dict()
            d["tax_details"] = [t.to_dict() for t in DocTax.query.filter_by(bill_id=self.id).all()]
            d["lines"] = [l.to_dict() for l in self.lines]
            d["payments"] = [p.to_dict() for p in self.payments]
            d["journal_entry_id"] = self.journal_entry_id
        return d


class BillLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    bill_id = db.Column(db.Integer, db.ForeignKey("bill.id"), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    amount_cents = db.Column(db.Integer, nullable=False, default=0)
    net_cents = db.Column(db.Integer, nullable=True)
    tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    account = db.relationship("Account")
    tax_code = db.relationship("TaxCode")

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "account": self.account.label,
            "description": self.description,
            "amount": money(self.amount_cents),
            "tax_code_id": self.tax_code_id,
            "tax": money(self.tax_cents),
        }


class Payment(db.Model):
    """Money received against an invoice, or paid against a bill."""

    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=True, index=True)
    bill_id = db.Column(db.Integer, db.ForeignKey("bill.id"), nullable=True, index=True)
    date = db.Column(db.Date, nullable=False)
    amount = db.Column(db.Integer, nullable=False)  # cents
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    method = db.Column(db.String(32), nullable=False, default="")
    reference = db.Column(db.String(64), nullable=False, default="")
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    account = db.relationship("Account")

    def to_dict(self):
        return {
            "id": self.id,
            "invoice_id": self.invoice_id,
            "bill_id": self.bill_id,
            "date": iso(self.date),
            "amount": money(self.amount),
            "account_id": self.account_id,
            "account": self.account.label,
            "method": self.method,
            "reference": self.reference,
        }


class Expense(db.Model):
    """A purchase paid immediately from a bank or credit card account."""

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    vendor_id = db.Column(db.Integer, db.ForeignKey("contact.id"), nullable=True)
    payee = db.Column(db.String(255), nullable=False, default="")
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)  # paid from
    method = db.Column(db.String(32), nullable=False, default="")
    reference = db.Column(db.String(64), nullable=False, default="")
    memo = db.Column(db.Text, nullable=False, default="")
    total_cents = db.Column(db.Integer, nullable=False, default=0)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    amounts_inclusive = db.Column(db.Boolean, nullable=False, default=False)
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=_utcnow)

    vendor = db.relationship("Contact")
    account = db.relationship("Account")
    lines = db.relationship("ExpenseLine", cascade="all, delete-orphan", order_by="ExpenseLine.id")

    def to_dict(self):
        return {
            "id": self.id,
            "date": iso(self.date),
            "vendor_id": self.vendor_id,
            "payee": self.vendor.name if self.vendor else self.payee,
            "account_id": self.account_id,
            "account": self.account.label,
            "method": self.method,
            "reference": self.reference,
            "memo": self.memo,
            "total": money(self.total_cents),
            "tax": money(self.tax_cents),
            "amounts_inclusive": self.amounts_inclusive,
            "lines": [l.to_dict() for l in self.lines],
            "category": ", ".join(sorted({l.account.name for l in self.lines})),
        }


class ExpenseLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    expense_id = db.Column(db.Integer, db.ForeignKey("expense.id"), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    amount_cents = db.Column(db.Integer, nullable=False, default=0)
    net_cents = db.Column(db.Integer, nullable=True)
    tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    account = db.relationship("Account")
    tax_code = db.relationship("TaxCode")

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "account": self.account.label,
            "description": self.description,
            "amount": money(self.amount_cents),
            "tax_code_id": self.tax_code_id,
            "tax": money(self.tax_cents),
        }


class BankTransaction(db.Model):
    """A line from a bank/credit card statement waiting to be reviewed."""

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False, index=True)
    date = db.Column(db.Date, nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    amount = db.Column(db.Integer, nullable=False)  # cents; positive = money in, negative = money out
    status = db.Column(db.String(16), nullable=False, default="review")  # review | categorized | excluded
    category_account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=True)
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    reconciled = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=_utcnow)
    # set for transactions pulled from a bank feed; used to avoid importing the same one twice
    external_id = db.Column(db.String(128), nullable=True, index=True)
    linked_account_id = db.Column(db.Integer, db.ForeignKey("linked_bank_account.id"), nullable=True)

    category_account = db.relationship("Account", foreign_keys=[category_account_id])

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "date": iso(self.date),
            "description": self.description,
            "amount": money(self.amount),
            "status": self.status,
            "category_account_id": self.category_account_id,
            "category": self.category_account.label if self.category_account else None,
            "journal_entry_id": self.journal_entry_id,
            "reconciled": self.reconciled,
            "source": "bank feed" if self.external_id else "import",
        }


class Item(db.Model):
    """A product or service you sell (and optionally buy)."""

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), unique=True, nullable=False)
    type = db.Column(db.String(16), nullable=False, default="service")  # service | non_inventory
    sku = db.Column(db.String(64), nullable=False, default="")
    description = db.Column(db.Text, nullable=False, default="")
    price_cents = db.Column(db.Integer, nullable=False, default=0)
    income_account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    cost_cents = db.Column(db.Integer, nullable=False, default=0)
    expense_account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=True)
    taxable = db.Column(db.Boolean, nullable=False, default=True)
    active = db.Column(db.Boolean, nullable=False, default=True)
    sales_tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)
    purchase_tax_code_id = db.Column(db.Integer, db.ForeignKey("tax_code.id"), nullable=True)
    stripe_tax_code = db.Column(db.String(32), nullable=False, default="")  # e.g. txcd_10000000

    income_account = db.relationship("Account", foreign_keys=[income_account_id])
    expense_account = db.relationship("Account", foreign_keys=[expense_account_id])

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "sku": self.sku,
            "description": self.description,
            "price": money(self.price_cents),
            "income_account_id": self.income_account_id,
            "income_account": self.income_account.label,
            "cost": money(self.cost_cents),
            "expense_account_id": self.expense_account_id,
            "expense_account": self.expense_account.label if self.expense_account else None,
            "taxable": self.taxable,
            "active": self.active,
            "sales_tax_code_id": self.sales_tax_code_id,
            "purchase_tax_code_id": self.purchase_tax_code_id,
            "stripe_tax_code": self.stripe_tax_code,
        }


class Reconciliation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False, index=True)
    statement_date = db.Column(db.Date, nullable=False)
    beginning_balance_cents = db.Column(db.Integer, nullable=False, default=0)
    ending_balance_cents = db.Column(db.Integer, nullable=False, default=0)
    completed_at = db.Column(db.DateTime, default=_utcnow)
    account = db.relationship("Account")

    def to_dict(self):
        return {
            "id": self.id,
            "account_id": self.account_id,
            "account": self.account.label,
            "statement_date": iso(self.statement_date),
            "beginning_balance": money(self.beginning_balance_cents),
            "ending_balance": money(self.ending_balance_cents),
            "completed_at": iso(self.completed_at),
        }


PAY_SCHEDULES = {"weekly": 52, "biweekly": 26, "semimonthly": 24, "monthly": 12}


class Employee(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    email = db.Column(db.String(255), nullable=False, default="")
    phone = db.Column(db.String(64), nullable=False, default="")
    address = db.Column(db.Text, nullable=False, default="")
    job_title = db.Column(db.String(128), nullable=False, default="")
    hire_date = db.Column(db.Date, nullable=True)
    pay_type = db.Column(db.String(16), nullable=False, default="hourly")  # hourly | salary
    pay_rate_cents = db.Column(db.Integer, nullable=False, default=0)  # per hour, or per year for salary
    pay_schedule = db.Column(db.String(16), nullable=False, default="biweekly")
    # Withholding percentages applied to gross pay (set per your jurisdiction / the employee's tax forms)
    federal_withholding_pct = db.Column(db.Float, nullable=False, default=0.0)
    state_withholding_pct = db.Column(db.Float, nullable=False, default=0.0)
    other_deduction_cents = db.Column(db.Integer, nullable=False, default=0)  # fixed per paycheck
    other_deduction_label = db.Column(db.String(64), nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)
    created_at = db.Column(db.DateTime, default=_utcnow)
    # How income tax is withheld: "percent" (fixed percentages above) or "tables" (W-4 + tax tables)
    withholding_method = db.Column(db.String(16), nullable=False, default="percent")
    w4_filing_status = db.Column(db.String(24), nullable=False, default="single")
    w4_multiple_jobs = db.Column(db.Boolean, nullable=False, default=False)  # Step 2(c) checkbox
    w4_dependents_cents = db.Column(db.Integer, nullable=False, default=0)  # Step 3
    w4_other_income_cents = db.Column(db.Integer, nullable=False, default=0)  # Step 4(a)
    w4_deductions_cents = db.Column(db.Integer, nullable=False, default=0)  # Step 4(b)
    w4_extra_cents = db.Column(db.Integer, nullable=False, default=0)  # Step 4(c), per paycheck
    work_state = db.Column(db.String(2), nullable=False, default="")
    state_filing_status = db.Column(db.String(24), nullable=False, default="single")
    state_allowances = db.Column(db.Integer, nullable=False, default=0)
    state_extra_cents = db.Column(db.Integer, nullable=False, default=0)

    def to_dict(self):
        return {
            "id": self.id,
            "withholding_method": self.withholding_method,
            "w4_filing_status": self.w4_filing_status,
            "w4_multiple_jobs": self.w4_multiple_jobs,
            "w4_dependents": money(self.w4_dependents_cents),
            "w4_other_income": money(self.w4_other_income_cents),
            "w4_deductions": money(self.w4_deductions_cents),
            "w4_extra": money(self.w4_extra_cents),
            "work_state": self.work_state,
            "state_filing_status": self.state_filing_status,
            "state_allowances": self.state_allowances,
            "state_extra": money(self.state_extra_cents),
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "job_title": self.job_title,
            "hire_date": iso(self.hire_date),
            "pay_type": self.pay_type,
            "pay_rate": money(self.pay_rate_cents),
            "pay_schedule": self.pay_schedule,
            "federal_withholding_pct": self.federal_withholding_pct,
            "state_withholding_pct": self.state_withholding_pct,
            "other_deduction": money(self.other_deduction_cents),
            "other_deduction_label": self.other_deduction_label,
            "active": self.active,
        }


class TimeEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employee.id"), nullable=False, index=True)
    date = db.Column(db.Date, nullable=False, index=True)
    hours = db.Column(db.Float, nullable=False, default=0)
    customer_id = db.Column(db.Integer, db.ForeignKey("contact.id"), nullable=True)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=True)
    billable = db.Column(db.Boolean, nullable=False, default=False)
    description = db.Column(db.Text, nullable=False, default="")
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=True, index=True)
    paycheck_id = db.Column(db.Integer, db.ForeignKey("paycheck.id"), nullable=True, index=True)

    employee = db.relationship("Employee")
    customer = db.relationship("Contact")
    item = db.relationship("Item")

    @property
    def locked(self):
        return self.invoice_id is not None or self.paycheck_id is not None

    def to_dict(self):
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "employee": self.employee.name,
            "date": iso(self.date),
            "hours": self.hours,
            "customer_id": self.customer_id,
            "customer": self.customer.name if self.customer else None,
            "item_id": self.item_id,
            "item": self.item.name if self.item else None,
            "rate": money(self.item.price_cents) if self.item else 0,
            "billable": self.billable,
            "description": self.description,
            "invoice_id": self.invoice_id,
            "paycheck_id": self.paycheck_id,
            "locked": self.locked,
        }


class PayrollRun(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    period_start = db.Column(db.Date, nullable=False)
    period_end = db.Column(db.Date, nullable=False)
    pay_date = db.Column(db.Date, nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)  # paid from
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=_utcnow)

    account = db.relationship("Account")
    paychecks = db.relationship("Paycheck", backref="run", cascade="all, delete-orphan", order_by="Paycheck.id")

    def to_dict(self, full=False):
        d = {
            "id": self.id,
            "period_start": iso(self.period_start),
            "period_end": iso(self.period_end),
            "pay_date": iso(self.pay_date),
            "account_id": self.account_id,
            "account": self.account.label,
            "employees": len(self.paychecks),
            "gross": money(sum(p.gross_cents for p in self.paychecks)),
            "net": money(sum(p.net_cents for p in self.paychecks)),
            "employer_taxes": money(sum(p.employer_tax_cents for p in self.paychecks)),
            "total_cost": money(sum(p.gross_cents + p.employer_tax_cents for p in self.paychecks)),
        }
        if full:
            d["paychecks"] = [p.to_dict() for p in self.paychecks]
        return d


class Paycheck(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("payroll_run.id"), nullable=False)
    employee_id = db.Column(db.Integer, db.ForeignKey("employee.id"), nullable=False)
    hours = db.Column(db.Float, nullable=False, default=0)
    gross_cents = db.Column(db.Integer, nullable=False, default=0)
    ss_cents = db.Column(db.Integer, nullable=False, default=0)
    medicare_cents = db.Column(db.Integer, nullable=False, default=0)
    federal_cents = db.Column(db.Integer, nullable=False, default=0)
    state_cents = db.Column(db.Integer, nullable=False, default=0)
    other_deduction_cents = db.Column(db.Integer, nullable=False, default=0)
    employer_tax_cents = db.Column(db.Integer, nullable=False, default=0)
    net_cents = db.Column(db.Integer, nullable=False, default=0)
    check_number = db.Column(db.String(32), nullable=False, default="")
    # breakdown (paychecks calculated from tax tables)
    method = db.Column(db.String(16), nullable=False, default="percent")
    addl_medicare_cents = db.Column(db.Integer, nullable=False, default=0)
    employer_ss_cents = db.Column(db.Integer, nullable=False, default=0)
    employer_medicare_cents = db.Column(db.Integer, nullable=False, default=0)
    futa_cents = db.Column(db.Integer, nullable=False, default=0)
    suta_cents = db.Column(db.Integer, nullable=False, default=0)

    employee = db.relationship("Employee")

    def to_dict(self):
        return {
            "id": self.id,
            "run_id": self.run_id,
            "employee_id": self.employee_id,
            "employee": self.employee.name,
            "hours": self.hours,
            "gross": money(self.gross_cents),
            "social_security": money(self.ss_cents),
            "medicare": money(self.medicare_cents),
            "federal_withholding": money(self.federal_cents),
            "state_withholding": money(self.state_cents),
            "other_deduction": money(self.other_deduction_cents),
            "other_deduction_label": self.employee.other_deduction_label,
            "employee_taxes": money(self.ss_cents + self.medicare_cents + self.addl_medicare_cents + self.federal_cents + self.state_cents),
            "employer_taxes": money(self.employer_tax_cents),
            "net": money(self.net_cents),
            "check_number": self.check_number,
            "method": self.method,
            "additional_medicare": money(self.addl_medicare_cents),
            "employer_social_security": money(self.employer_ss_cents),
            "employer_medicare": money(self.employer_medicare_cents),
            "futa": money(self.futa_cents),
            "suta": money(self.suta_cents),
        }


# ---------------------------------------------------------------- sales tax / VAT / GST

FILING_FREQUENCIES = ("monthly", "quarterly", "annually")

tax_code_rates = db.Table(
    "tax_code_rate",
    db.Column("tax_code_id", db.Integer, db.ForeignKey("tax_code.id"), primary_key=True),
    db.Column("tax_rate_id", db.Integer, db.ForeignKey("tax_rate.id"), primary_key=True),
)


class TaxAgency(db.Model):
    """A tax authority you collect for and pay to (e.g. a state revenue department, HMRC, CRA)."""

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), unique=True, nullable=False)
    registration_number = db.Column(db.String(64), nullable=False, default="")
    filing_frequency = db.Column(db.String(16), nullable=False, default="quarterly")
    source = db.Column(db.String(16), nullable=False, default="manual")  # manual | stripe
    active = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "registration_number": self.registration_number,
            "filing_frequency": self.filing_frequency,
            "source": self.source,
            "active": self.active,
        }


class TaxRate(db.Model):
    """One component rate charged by one agency (e.g. 'State 6.5%')."""

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    agency_id = db.Column(db.Integer, db.ForeignKey("tax_agency.id"), nullable=False)
    rate = db.Column(db.Float, nullable=False, default=0.0)  # percent
    applies_to = db.Column(db.String(16), nullable=False, default="sales")  # sales | purchases | both
    active = db.Column(db.Boolean, nullable=False, default=True)
    agency = db.relationship("TaxAgency")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "agency_id": self.agency_id,
            "agency": self.agency.name,
            "rate": self.rate,
            "applies_to": self.applies_to,
            "active": self.active,
        }


class TaxCode(db.Model):
    """What you pick on a line: one or more component rates (e.g. 'Seattle' = state + county + city)."""

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), unique=True, nullable=False)
    description = db.Column(db.String(255), nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)
    rates = db.relationship("TaxRate", secondary=tax_code_rates, order_by="TaxRate.id")

    def rates_for(self, direction):
        return [r for r in self.rates if r.applies_to in (direction, "both")]

    def total_rate(self, direction="sales"):
        return round(sum(r.rate for r in self.rates_for(direction)), 6)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "active": self.active,
            "rate_ids": [r.id for r in self.rates],
            "rates": [r.to_dict() for r in self.rates],
            "sales_rate": self.total_rate("sales"),
            "purchase_rate": self.total_rate("purchases"),
            "label": f"{self.name} ({self.total_rate('sales'):g}%)" if self.rates else self.name,
        }


class DocTax(db.Model):
    """Snapshot of the tax on one saved document, per component rate.

    Kept with the document so later changes to rates never rewrite history;
    the sales tax liability report is built from these rows.
    """

    id = db.Column(db.Integer, primary_key=True)
    direction = db.Column(db.String(16), nullable=False)  # sales | purchases
    date = db.Column(db.Date, nullable=False, index=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=True, index=True)
    bill_id = db.Column(db.Integer, db.ForeignKey("bill.id"), nullable=True, index=True)
    expense_id = db.Column(db.Integer, db.ForeignKey("expense.id"), nullable=True, index=True)
    agency_id = db.Column(db.Integer, db.ForeignKey("tax_agency.id"), nullable=True, index=True)
    rate_id = db.Column(db.Integer, db.ForeignKey("tax_rate.id"), nullable=True)
    name = db.Column(db.String(255), nullable=False, default="")
    rate = db.Column(db.Float, nullable=False, default=0.0)
    taxable_cents = db.Column(db.Integer, nullable=False, default=0)
    tax_cents = db.Column(db.Integer, nullable=False, default=0)
    agency = db.relationship("TaxAgency")

    def to_dict(self):
        return {
            "id": self.id,
            "direction": self.direction,
            "agency_id": self.agency_id,
            "agency": self.agency.name if self.agency else None,
            "rate_id": self.rate_id,
            "name": self.name,
            "rate": self.rate,
            "taxable": money(self.taxable_cents),
            "tax": money(self.tax_cents),
        }


class TaxPayment(db.Model):
    """A payment to (or refund from) a tax agency for a filing period."""

    id = db.Column(db.Integer, primary_key=True)
    agency_id = db.Column(db.Integer, db.ForeignKey("tax_agency.id"), nullable=False, index=True)
    period_start = db.Column(db.Date, nullable=False)
    period_end = db.Column(db.Date, nullable=False)
    date = db.Column(db.Date, nullable=False)
    amount_cents = db.Column(db.Integer, nullable=False)  # positive = paid to agency, negative = refund received
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=False)
    reference = db.Column(db.String(64), nullable=False, default="")
    memo = db.Column(db.Text, nullable=False, default="")
    journal_entry_id = db.Column(db.Integer, db.ForeignKey("journal_entry.id"), nullable=True)
    agency = db.relationship("TaxAgency")
    account = db.relationship("Account")

    def to_dict(self):
        return {
            "id": self.id,
            "agency_id": self.agency_id,
            "agency": self.agency.name,
            "period_start": iso(self.period_start),
            "period_end": iso(self.period_end),
            "date": iso(self.date),
            "amount": money(self.amount_cents),
            "account_id": self.account_id,
            "account": self.account.label,
            "reference": self.reference,
            "memo": self.memo,
        }


class PayrollTaxTable(db.Model):
    """An editable payroll tax table for one tax year and jurisdiction.

    kind: income_tax | social_security | medicare | futa | suta
    jurisdiction: US-FED or US-<state>. `data` is JSON (see payroll_tax.py).
    """

    __table_args__ = (db.UniqueConstraint("tax_year", "jurisdiction", "kind"),)

    id = db.Column(db.Integer, primary_key=True)
    tax_year = db.Column(db.Integer, nullable=False, index=True)
    jurisdiction = db.Column(db.String(16), nullable=False)
    kind = db.Column(db.String(24), nullable=False)
    name = db.Column(db.String(255), nullable=False)
    data = db.Column(db.Text, nullable=False, default="{}")
    source = db.Column(db.String(255), nullable=False, default="")
    builtin = db.Column(db.Boolean, nullable=False, default=False)
    verified = db.Column(db.Boolean, nullable=False, default=False)
    verified_by = db.Column(db.String(255), nullable=False, default="")
    verified_at = db.Column(db.DateTime, nullable=True)
    updated_at = db.Column(db.DateTime, default=_utcnow, onupdate=_utcnow)

    def values(self):
        import json

        return json.loads(self.data or "{}")

    def to_dict(self):
        return {
            "id": self.id,
            "tax_year": self.tax_year,
            "jurisdiction": self.jurisdiction,
            "kind": self.kind,
            "name": self.name,
            "data": self.values(),
            "source": self.source,
            "builtin": self.builtin,
            "verified": self.verified,
            "verified_by": self.verified_by,
            "verified_at": iso(self.verified_at),
        }


class BankConnection(db.Model):
    """A login to one bank through a bank-data provider (SimpleFIN, Plaid or GoCardless)."""

    id = db.Column(db.Integer, primary_key=True)
    provider = db.Column(db.String(16), nullable=False)
    institution = db.Column(db.String(255), nullable=False, default="")
    status = db.Column(db.String(16), nullable=False, default="active")  # pending | active | error | disconnected
    secret = db.Column(db.Text, nullable=False, default="")  # encrypted provider credentials (never sent to the browser)
    cursor = db.Column(db.Text, nullable=False, default="")  # Plaid sync cursor
    last_synced_at = db.Column(db.DateTime, nullable=True)
    last_error = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime, default=_utcnow)
    accounts = db.relationship("LinkedBankAccount", backref="connection", cascade="all, delete-orphan", order_by="LinkedBankAccount.id")

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "institution": self.institution,
            "status": self.status,
            "last_synced_at": iso(self.last_synced_at),
            "last_error": self.last_error,
            "accounts": [a.to_dict() for a in self.accounts],
        }


class LinkedBankAccount(db.Model):
    """An account at the bank, optionally matched to an OpenBooks bank / credit card account."""

    id = db.Column(db.Integer, primary_key=True)
    connection_id = db.Column(db.Integer, db.ForeignKey("bank_connection.id"), nullable=False)
    external_id = db.Column(db.String(128), nullable=False)
    name = db.Column(db.String(255), nullable=False, default="")
    mask = db.Column(db.String(16), nullable=False, default="")
    currency = db.Column(db.String(8), nullable=False, default="")
    balance_cents = db.Column(db.Integer, nullable=True)
    account_id = db.Column(db.Integer, db.ForeignKey("account.id"), nullable=True)  # OpenBooks account
    sync_from = db.Column(db.Date, nullable=True)  # import transactions on or after this date
    active = db.Column(db.Boolean, nullable=False, default=True)
    account = db.relationship("Account")

    def to_dict(self):
        return {
            "id": self.id,
            "external_id": self.external_id,
            "name": self.name,
            "mask": self.mask,
            "currency": self.currency,
            "balance": money(self.balance_cents) if self.balance_cents is not None else None,
            "account_id": self.account_id,
            "account": self.account.label if self.account else None,
            "sync_from": iso(self.sync_from),
            "active": self.active,
        }
