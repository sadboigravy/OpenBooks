"""First-run defaults and optional sample data."""
import json
import logging
import os
from datetime import date, timedelta

from werkzeug.security import generate_password_hash

from .models import Account, Contact, JournalEntry, Setting, User, db

log = logging.getLogger("openbooks")

DEFAULT_ADMIN_EMAIL = "admin@openbooks.local"
DEFAULT_ADMIN_PASSWORD = "openbooks"

DEFAULT_SETTINGS = {
    "company_name": "My Company",
    "company_email": "",
    "company_phone": "",
    "company_address": "",
    "currency": "USD",
    "default_tax_rate": "0",
    "invoice_prefix": "INV-",
    "next_invoice_number": "1001",
    "default_terms_days": "30",
    "fiscal_year_start_month": "1",
    "estimate_prefix": "EST-",
    "next_estimate_number": "1001",
    "receipt_prefix": "SR-",
    "next_receipt_number": "1001",
    # Payroll: rates are percentages; set them for your jurisdiction
    "payroll_ss_rate": "6.2",
    "payroll_medicare_rate": "1.45",
    "payroll_employer_extra_rate": "0",
    "payroll_ss_wage_base": "176100",
    # Sales tax / VAT / GST
    "tax_provider": "manual",  # manual | stripe_tax
    "default_sales_tax_code_id": "",
    "default_purchase_tax_code_id": "",
    "prices_include_tax": "false",
    "stripe_default_tax_code": "",
}

# code, name, type, subtype, is_system
DEFAULT_ACCOUNTS = [
    ("1000", "Cash on Hand", "asset", "cash", False),
    ("1010", "Business Checking", "asset", "bank", False),
    ("1020", "Business Savings", "asset", "bank", False),
    ("1200", "Accounts Receivable", "asset", "accounts_receivable", True),
    ("1300", "Inventory", "asset", "other_current_asset", False),
    ("1400", "Prepaid Expenses", "asset", "other_current_asset", False),
    ("1500", "Equipment", "asset", "fixed_asset", False),
    ("1590", "Accumulated Depreciation", "asset", "fixed_asset", False),
    ("2000", "Accounts Payable", "liability", "accounts_payable", True),
    ("2100", "Business Credit Card", "liability", "credit_card", False),
    ("2200", "Sales Tax Payable", "liability", "sales_tax", True),
    ("2300", "Payroll Liabilities", "liability", "payroll_liability", True),
    ("2500", "Loans Payable", "liability", "long_term_liability", False),
    ("3000", "Owner's Equity", "equity", "owner_equity", False),
    ("3100", "Owner's Draw", "equity", "owner_equity", False),
    ("3900", "Retained Earnings", "equity", "retained_earnings", True),
    ("4000", "Sales", "income", "income", False),
    ("4100", "Service Revenue", "income", "income", False),
    ("4900", "Other Income", "income", "other_income", False),
    ("5000", "Cost of Goods Sold", "expense", "cost_of_goods_sold", False),
    ("6000", "Advertising & Marketing", "expense", "expense", False),
    ("6100", "Bank Fees", "expense", "expense", False),
    ("6150", "Depreciation", "expense", "expense", False),
    ("6200", "Insurance", "expense", "expense", False),
    ("6300", "Meals", "expense", "expense", False),
    ("6400", "Office Supplies", "expense", "expense", False),
    ("6500", "Professional Fees", "expense", "expense", False),
    ("6600", "Rent", "expense", "expense", False),
    ("6700", "Utilities", "expense", "expense", False),
    ("6800", "Wages & Salaries", "expense", "payroll_expense", True),
    ("6810", "Payroll Taxes", "expense", "payroll_tax_expense", True),
    ("6900", "Travel", "expense", "expense", False),
    ("6950", "Software & Subscriptions", "expense", "expense", False),
    ("6990", "Miscellaneous Expense", "expense", "expense", False),
]


def ensure_defaults():
    for key, value in DEFAULT_SETTINGS.items():
        if db.session.get(Setting, key) is None:
            db.session.add(Setting(key=key, value=value))

    if Account.query.count() == 0:
        for code, name, type_, subtype, is_system in DEFAULT_ACCOUNTS:
            db.session.add(
                Account(code=code, name=name, type=type_, subtype=subtype, is_system=is_system)
            )
    else:
        _ensure_payroll_accounts()

    if User.query.count() == 0:
        email = os.environ.get("ADMIN_EMAIL", DEFAULT_ADMIN_EMAIL).strip().lower()
        password = os.environ.get("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
        uses_default = password == DEFAULT_ADMIN_PASSWORD
        db.session.add(
            User(
                email=email,
                name="Administrator",
                password_hash=generate_password_hash(password),
                role="admin",
                is_bootstrap=uses_default,
            )
        )
        if uses_default:
            log.warning("Created first-run login %s; signing in with it will ask you to create your own admin account", email)
        else:
            log.warning("Created initial admin user %s", email)
    else:
        _flag_default_logins()

    db.session.commit()
    _migrate_legacy_tax()
    ensure_payroll_tables()

    if os.environ.get("DEMO_DATA", "").lower() in ("1", "true", "yes") and books_empty():
        load_demo_data()


def books_empty():
    return JournalEntry.query.count() == 0


def load_demo_data():
    """Load sample data and remember exactly which records it created, so it can be removed later."""
    before = _max_ids()
    _load_demo_data()
    after = _max_ids()
    marker = {name: [before[name], after[name]] for name in after if after[name] > before[name]}
    row = db.session.get(Setting, "sample_data") or Setting(key="sample_data")
    row.value = json.dumps(marker)
    db.session.add(row)
    db.session.commit()


def _load_demo_data():
    """Populate the books with a few months of realistic sample activity."""
    from .api.banking import create_bank_transaction
    from .api.purchases import save_bill, save_bill_payment, save_expense
    from .api.sales import save_invoice, save_payment
    from .ledger import post_entry

    acct = {a.code: a.id for a in Account.query.all()}
    today = date.today()

    def d(days_ago):
        return (today - timedelta(days=days_ago)).isoformat()

    def contact(kind, name, company, email):
        c = Contact(kind=kind, name=name, company=company, email=email)
        db.session.add(c)
        db.session.flush()
        return c.id

    acme = contact("customer", "Dana Whitfield", "Acme Logistics", "dana@acme.example")
    birch = contact("customer", "Sam Ortega", "Birch & Co. Design", "sam@birch.example")
    cedar = contact("customer", "Priya Nair", "Cedar Health Clinic", "priya@cedar.example")
    landlord = contact("vendor", "Harbor Properties", "Harbor Properties LLC", "billing@harbor.example")
    power = contact("vendor", "City Power & Water", "", "accounts@citypower.example")
    print_co = contact("vendor", "QuickPrint Supplies", "", "orders@qprint.example")

    post_entry(
        date=today - timedelta(days=120),
        memo="Owner investment to start the business",
        source_type="manual",
        lines=[
            {"account_id": acct["1010"], "debit": 2500000},
            {"account_id": acct["3000"], "credit": 2500000},
        ],
    )

    def inv(customer, days_ago, terms, lines, pay=None):
        invoice = save_invoice(
            {
                "customer_id": customer,
                "date": d(days_ago),
                "due_date": d(days_ago - terms),
                "tax_rate": 0,
                "lines": lines,
            }
        )
        if pay:
            save_payment(
                invoice,
                {"date": d(pay[0]), "amount": pay[1], "account_id": acct["1010"], "method": "ACH"},
            )

    inv(acme, 110, 30, [{"description": "Logistics consulting – phase 1", "quantity": 40, "unit_price": 150, "account_id": acct["4100"]}], (85, 6000))
    inv(birch, 95, 30, [{"description": "Website build", "quantity": 1, "unit_price": 4800, "account_id": acct["4100"]}], (70, 4800))
    inv(cedar, 75, 30, [{"description": "Patient portal design", "quantity": 1, "unit_price": 3200, "account_id": acct["4100"]}, {"description": "Printed brochures", "quantity": 500, "unit_price": 1.2, "account_id": acct["4000"]}], (40, 2000))
    inv(acme, 60, 30, [{"description": "Logistics consulting – phase 2", "quantity": 32, "unit_price": 150, "account_id": acct["4100"]}], (28, 4800))
    inv(birch, 45, 15, [{"description": "Brand refresh", "quantity": 1, "unit_price": 2750, "account_id": acct["4100"]}])
    inv(cedar, 20, 30, [{"description": "Monthly retainer", "quantity": 1, "unit_price": 1500, "account_id": acct["4100"]}])
    inv(acme, 5, 30, [{"description": "Route optimisation workshop", "quantity": 1, "unit_price": 2200, "account_id": acct["4100"]}])

    for days_ago in (110, 80, 50, 20):
        bill = save_bill(
            {
                "vendor_id": landlord,
                "number": f"R-{days_ago}",
                "date": d(days_ago),
                "due_date": d(days_ago - 10),
                "lines": [{"description": "Office rent", "amount": 1800, "account_id": acct["6600"]}],
            }
        )
        if days_ago > 25:
            save_bill_payment(bill, {"date": d(days_ago - 8), "amount": 1800, "account_id": acct["1010"], "method": "Check"})
    for days_ago, amount in ((100, 214.37), (70, 198.12), (40, 231.55), (10, 205.9)):
        bill = save_bill(
            {
                "vendor_id": power,
                "date": d(days_ago),
                "due_date": d(days_ago - 21),
                "lines": [{"description": "Electricity & water", "amount": amount, "account_id": acct["6700"]}],
            }
        )
        if days_ago > 30:
            save_bill_payment(bill, {"date": d(days_ago - 15), "amount": amount, "account_id": acct["1010"], "method": "ACH"})

    expenses = [
        (105, print_co, "2100", "6400", 142.80, "Printer paper & toner"),
        (90, None, "2100", "6950", 59.00, "Accounting software subscription"),
        (88, None, "1010", "6200", 640.00, "Business liability insurance"),
        (66, None, "2100", "6300", 86.45, "Client lunch"),
        (60, None, "2100", "6950", 59.00, "Accounting software subscription"),
        (52, None, "2100", "6000", 450.00, "Online ad campaign"),
        (35, None, "2100", "6900", 389.20, "Train tickets – client visit"),
        (30, None, "2100", "6950", 59.00, "Accounting software subscription"),
        (14, print_co, "2100", "6400", 73.15, "Notebooks & pens"),
        (3, None, "1010", "6100", 15.00, "Monthly account fee"),
    ]
    for days_ago, vendor, paid_from, category, amount, memo in expenses:
        save_expense(
            {
                "date": d(days_ago),
                "vendor_id": vendor,
                "payee": "" if vendor else memo.split(" ")[0],
                "account_id": acct[paid_from],
                "lines": [{"account_id": acct[category], "amount": amount, "description": memo}],
            }
        )

    post_entry(
        date=today - timedelta(days=45),
        memo="Pay down credit card",
        source_type="manual",
        lines=[
            {"account_id": acct["2100"], "debit": 75000},
            {"account_id": acct["1010"], "credit": 75000},
        ],
    )

    # Products & services, estimates and a sales receipt
    from .api.banking import _save_deposit, _save_transfer
    from .api.payroll import run_payroll
    from .models import Employee, Item, TimeEntry

    from .models import TaxAgency, TaxCode, TaxRate

    state = TaxAgency(name="State Department of Revenue", filing_frequency="quarterly", registration_number="ST-4471-09")
    city = TaxAgency(name="City of Riverton", filing_frequency="quarterly")
    db.session.add_all([state, city])
    db.session.flush()
    r_state = TaxRate(name="State sales tax 6%", agency_id=state.id, rate=6.0)
    r_city = TaxRate(name="Riverton city tax 2%", agency_id=city.id, rate=2.0)
    local_code = TaxCode(name="Riverton 8%", description="State 6% + city 2%", rates=[r_state, r_city])
    db.session.add_all([r_state, r_city, local_code])
    db.session.flush()
    from .api.settings import set_setting

    set_setting("default_sales_tax_code_id", local_code.id)

    consulting = Item(name="Consulting (hourly)", type="service", description="Operations consulting", price_cents=15000, income_account_id=acct["4100"])
    design = Item(name="Website design", type="service", description="Design and build of a marketing website", price_cents=480000, income_account_id=acct["4100"])
    brochures = Item(name="Printed brochures", type="non_inventory", sku="BR-100", description="Tri-fold brochure, full colour", price_cents=120, cost_cents=45, income_account_id=acct["4000"], expense_account_id=acct["5000"], sales_tax_code_id=local_code.id)
    db.session.add_all([consulting, design, brochures])
    db.session.flush()

    save_invoice({"kind": "estimate", "customer_id": cedar, "date": d(8), "due_date": d(-22), "lines": [{"item_id": design.id, "description": design.description, "quantity": 1, "unit_price": 4800}]})
    save_invoice({"kind": "estimate", "customer_id": birch, "date": d(3), "due_date": d(-27), "lines": [{"item_id": consulting.id, "description": "Discovery workshop", "quantity": 6, "unit_price": 150}]})
    save_invoice({"kind": "sales_receipt", "customer_id": birch, "date": d(12), "deposit_account_id": acct["1010"], "method": "Credit card", "lines": [{"item_id": brochures.id, "description": brochures.description, "quantity": 250, "unit_price": 1.2, "tax_code_id": local_code.id}]})
    save_invoice({"customer_id": cedar, "date": d(50), "due_date": d(20), "lines": [{"item_id": brochures.id, "description": "Patient leaflets", "quantity": 1000, "unit_price": 1.2, "tax_code_id": local_code.id}]})

    _save_deposit({"date": d(33), "account_id": acct["1010"], "memo": "Equipment resale", "lines": [{"account_id": acct["4900"], "description": "Sold old laptop", "amount": 320}]})
    _save_transfer({"date": d(25), "from_account_id": acct["1010"], "to_account_id": acct["1020"], "amount": 5000, "memo": "Move to savings"})

    # Employees, timesheets and one payroll run
    jordan = Employee(name="Jordan Lee", email="jordan@example.com", job_title="Consultant", pay_type="hourly", pay_rate_cents=3200, pay_schedule="biweekly", federal_withholding_pct=10, state_withholding_pct=4, hire_date=today - timedelta(days=200))
    alex = Employee(name="Alex Kim", email="alex@example.com", job_title="Office manager", pay_type="salary", pay_rate_cents=5200000, pay_schedule="biweekly", federal_withholding_pct=12, state_withholding_pct=5, other_deduction_cents=5000, other_deduction_label="Health plan", hire_date=today - timedelta(days=400))
    db.session.add_all([jordan, alex])
    db.session.flush()
    for days_ago in range(27, 0, -1):
        day = today - timedelta(days=days_ago)
        if day.weekday() >= 5:
            continue
        billable = day.weekday() in (1, 3)
        db.session.add(TimeEntry(employee_id=jordan.id, date=day, hours=8, customer_id=acme if billable else None, item_id=consulting.id if billable else None, billable=billable, description="On-site consulting" if billable else "Internal"))
        db.session.add(TimeEntry(employee_id=alex.id, date=day, hours=8, description="Office"))
    db.session.flush()
    period_end = today - timedelta(days=14)
    run_payroll({
        "period_start": (period_end - timedelta(days=13)).isoformat(),
        "period_end": period_end.isoformat(),
        "pay_date": (period_end + timedelta(days=3)).isoformat(),
        "account_id": acct["1010"],
        "employees": [{"employee_id": jordan.id}, {"employee_id": alex.id}],
    })

    for days_ago, desc, amount in (
        (2, "CARD 4421 COFFEE ROASTERS", -18.75),
        (2, "STRIPE TRANSFER", 1240.00),
        (1, "AMZN MKTP office chair", -229.99),
        (1, "INTEREST PAYMENT", 3.12),
    ):
        create_bank_transaction(acct["1010"], d(days_ago), desc, amount)

    db.session.commit()


def _ensure_payroll_accounts():
    """Databases created by older versions need the system payroll accounts."""
    wanted = {
        "payroll_liability": ("2300", "Payroll Liabilities", "liability"),
        "payroll_expense": ("6800", "Wages & Salaries", "expense"),
        "payroll_tax_expense": ("6810", "Payroll Taxes", "expense"),
    }
    for subtype, (code, name, type_) in wanted.items():
        if Account.query.filter_by(subtype=subtype).first():
            continue
        existing = Account.query.filter_by(code=code).first()
        if existing and existing.type == type_:
            existing.subtype = subtype
            existing.is_system = True
            continue
        new_code = code
        while Account.query.filter_by(code=new_code).first():
            new_code = str(int(new_code) + 1)
        db.session.add(Account(code=new_code, name=name, type=type_, subtype=subtype, is_system=True))
    db.session.flush()


def _migrate_legacy_tax():
    """One-time upgrade of flat-rate invoices to the tax engine (agency + rate + code).

    Keeps every saved total exactly as it was and backfills the tax history used
    by the sales tax liability report.
    """
    from .models import DocTax, Invoice, TaxAgency, TaxCode, TaxRate

    if db.session.get(Setting, "tax_engine_version"):
        return
    invoices = Invoice.query.filter(Invoice.tax_rate > 0).all()
    default_rate = float(getattr(db.session.get(Setting, "default_tax_rate"), "value", "0") or 0)
    rates_needed = sorted({i.tax_rate for i in invoices} | ({default_rate} if default_rate else set()))
    codes = {}
    if rates_needed:
        agency = TaxAgency.query.filter_by(name="Sales tax").first() or TaxAgency(name="Sales tax", filing_frequency="quarterly")
        db.session.add(agency)
        db.session.flush()
        for pct in rates_needed:
            rate = TaxRate(name=f"Sales tax {pct:g}%", agency_id=agency.id, rate=pct)
            code = TaxCode(name=f"Sales tax {pct:g}%", rates=[rate])
            db.session.add_all([rate, code])
            db.session.flush()
            codes[pct] = (code, rate, agency)
        if default_rate:
            row = db.session.get(Setting, "default_sales_tax_code_id")
            if row is not None and not row.value:
                row.value = str(codes[default_rate][0].id)
    for inv in invoices:
        code, rate, agency = codes[inv.tax_rate]
        taxable = 0
        for line in inv.lines:
            line.net_cents = line.amount_cents
            if line.taxable:
                line.tax_code_id = code.id
                taxable += line.amount_cents
        if inv.kind != "estimate" and inv.status not in ("draft", "void") and inv.tax_cents:
            db.session.add(
                DocTax(direction="sales", date=inv.date, invoice_id=inv.id, agency_id=agency.id, rate_id=rate.id, name=rate.name, rate=rate.rate, taxable_cents=taxable, tax_cents=inv.tax_cents)
            )
        inv.tax_source = "codes"
        inv.tax_rate = 0
    db.session.add(Setting(key="tax_engine_version", value="1"))
    db.session.commit()


def ensure_payroll_tables():
    """Add any missing built-in payroll tax tables. Never overwrites tables an admin has edited."""
    import json

    from .models import PayrollTaxTable
    from .payroll_tax import builtin_tables

    existing = {(t.tax_year, t.jurisdiction, t.kind) for t in PayrollTaxTable.query.all()}
    for year, jur, kind, name, data, source in builtin_tables():
        if (year, jur, kind) not in existing:
            db.session.add(PayrollTaxTable(tax_year=year, jurisdiction=jur, kind=kind, name=name, data=json.dumps(data), source=source, builtin=True))
    db.session.commit()


def _flag_default_logins():
    """Older installs: an admin still using the built-in default password must set up a real account."""
    from werkzeug.security import check_password_hash

    for user in User.query.filter_by(is_bootstrap=False, role="admin").all():
        if check_password_hash(user.password_hash, DEFAULT_ADMIN_PASSWORD):
            user.is_bootstrap = True
            log.warning("Admin %s still uses the default password; they will be asked to create a new admin account", user.email)


# ---------------------------------------------------------------- removing sample data / erasing the books


def _tracked_models():
    """Top-level records, in the order they can be safely deleted (children are removed with their parents)."""
    from .models import (
        BankTransaction,
        Bill,
        Contact,
        DocTax,
        Employee,
        Expense,
        Invoice,
        Item,
        JournalEntry,
        Payment,
        PayrollRun,
        Reconciliation,
        TaxAgency,
        TaxCode,
        TaxPayment,
        TaxRate,
        TimeEntry,
    )

    return [
        ("reconciliation", Reconciliation),
        ("doc_tax", DocTax),
        ("tax_payment", TaxPayment),
        ("payment", Payment),
        ("time_entry", TimeEntry),
        ("payroll_run", PayrollRun),
        ("invoice", Invoice),
        ("bill", Bill),
        ("expense", Expense),
        ("bank_transaction", BankTransaction),
        ("journal_entry", JournalEntry),
        ("item", Item),
        ("employee", Employee),
        ("contact", Contact),
        ("tax_code", TaxCode),
        ("tax_rate", TaxRate),
        ("tax_agency", TaxAgency),
    ]


def _max_ids():
    from sqlalchemy import func

    return {name: int(db.session.query(func.coalesce(func.max(model.id), 0)).scalar()) for name, model in _tracked_models()}


def sample_data_status():
    row = db.session.get(Setting, "sample_data")
    if not row or not row.value:
        return None
    try:
        return json.loads(row.value)
    except ValueError:
        return None


def _delete(name, model, cond):
    """Delete rows of one tracked table matching `cond`, together with their child rows."""
    from .models import BillLine, ExpenseLine, InvoiceLine, JournalLine, Paycheck, TimeEntry, tax_code_rates

    ids = [r.id for r in model.query.filter(cond).all()]
    if not ids:
        return
    if name == "reconciliation":
        JournalLine.query.filter(JournalLine.reconciliation_id.in_(ids)).update({"reconciliation_id": None}, synchronize_session=False)
    elif name == "payroll_run":
        checks = [p.id for p in Paycheck.query.filter(Paycheck.run_id.in_(ids)).all()]
        if checks:
            TimeEntry.query.filter(TimeEntry.paycheck_id.in_(checks)).update({"paycheck_id": None}, synchronize_session=False)
        Paycheck.query.filter(Paycheck.run_id.in_(ids)).delete(synchronize_session=False)
    elif name == "invoice":
        TimeEntry.query.filter(TimeEntry.invoice_id.in_(ids)).update({"invoice_id": None}, synchronize_session=False)
        InvoiceLine.query.filter(InvoiceLine.invoice_id.in_(ids)).delete(synchronize_session=False)
    elif name == "bill":
        BillLine.query.filter(BillLine.bill_id.in_(ids)).delete(synchronize_session=False)
    elif name == "expense":
        ExpenseLine.query.filter(ExpenseLine.expense_id.in_(ids)).delete(synchronize_session=False)
    elif name == "journal_entry":
        JournalLine.query.filter(JournalLine.entry_id.in_(ids)).delete(synchronize_session=False)
    elif name == "tax_code":
        db.session.execute(tax_code_rates.delete().where(tax_code_rates.c.tax_code_id.in_(ids)))
    elif name == "tax_rate":
        db.session.execute(tax_code_rates.delete().where(tax_code_rates.c.tax_rate_id.in_(ids)))
    model.query.filter(model.id.in_(ids)).delete(synchronize_session=False)


def _after_erase():
    """Reset numbering and clear settings that pointed at deleted records."""
    from .models import Invoice, TaxCode

    for key in ("default_sales_tax_code_id", "default_purchase_tax_code_id"):
        row = db.session.get(Setting, key)
        if row and row.value and db.session.get(TaxCode, int(row.value)) is None:
            row.value = ""
    for kind, key in (("invoice", "next_invoice_number"), ("estimate", "next_estimate_number"), ("sales_receipt", "next_receipt_number")):
        if not Invoice.query.filter_by(kind=kind).first():
            row = db.session.get(Setting, key)
            if row:
                row.value = "1001"


def remove_sample_data():
    """Delete exactly the records the sample-data loader created.

    Refuses if records were added afterwards, since they may depend on sample
    customers, products or accounts; use erase_books() in that case.
    """
    from .util import ApiError

    marker = sample_data_status()
    if not marker:
        raise ApiError("There is no sample data to remove")
    now = _max_ids()
    added = [name for name, (_, last) in marker.items() if now.get(name, 0) > last]
    added += [name for name in now if name not in marker and now[name] > 0 and name in ("invoice", "bill", "expense", "journal_entry")]
    if added:
        raise ApiError(
            "You've added your own records since loading the sample data, so it can't be separated safely. "
            "Use 'Erase all data' in Settings to start fresh instead.",
            409,
        )
    for name, model in _tracked_models():
        if name in marker:
            first, last = marker[name]
            _delete(name, model, (model.id > first) & (model.id <= last))
    db.session.delete(db.session.get(Setting, "sample_data"))
    _after_erase()
    db.session.commit()


def erase_books(include_tax_setup=False):
    """Delete every transaction and list (customers, vendors, products, employees).

    Keeps users, company settings, the chart of accounts and payroll tax tables,
    and the sales tax setup unless `include_tax_setup` is true.
    """
    for name, model in _tracked_models():
        if name in ("tax_code", "tax_rate", "tax_agency") and not include_tax_setup:
            continue
        _delete(name, model, model.id > 0)
    row = db.session.get(Setting, "sample_data")
    if row:
        db.session.delete(row)
    _after_erase()
    db.session.commit()
