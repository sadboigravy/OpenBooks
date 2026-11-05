"""Sales tax / VAT / GST: agencies, rates, codes, calculation, liability and payments."""
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from flask import jsonify, request
from sqlalchemy import func

from ..ledger import delete_entry, post_entry, system_account
from ..models import (
    FILING_FREQUENCIES,
    SUBTYPE_SALES_TAX,
    Account,
    Bill,
    BillLine,
    Contact,
    DocTax,
    Expense,
    ExpenseLine,
    Invoice,
    InvoiceLine,
    Item,
    TaxAgency,
    TaxCode,
    TaxPayment,
    TaxRate,
    db,
    money,
)
from ..tax import TaxLineInput, TaxResult, calculate, stripe_tax_calculate
from ..util import ApiError, arg_date, body, get_or_404, opt_str, parse_date, required_str, to_cents, to_decimal
from . import bp, require_admin

PROVIDERS = ("manual", "stripe_tax")


def _settings():
    from .settings import get_settings

    return get_settings()


# ---------------------------------------------------------------- calculation used by documents


def _legacy(lines, rate):
    """Documents saved before the tax engine: one flat rate on lines marked taxable."""
    res = TaxResult()
    taxable = sum(l.amount_cents for l in lines if l.taxable)
    tax = int((Decimal(taxable) * Decimal(str(rate)) / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    res.line_net = [l.amount_cents for l in lines]
    res.line_tax = [0 for _ in lines]
    res.subtotal_cents = sum(res.line_net)
    res.tax_cents = tax
    res.total_cents = res.subtotal_cents + tax
    if tax:
        res.details = [{"rate": None, "agency_id": None, "rate_id": None, "name": f"Sales tax {rate:g}%", "rate_pct": rate, "taxable_cents": taxable, "tax_cents": tax}]
    return res


def stripe_tax_enabled():
    from .online_payments import cfg

    return _settings().get("tax_provider") == "stripe_tax" and bool(cfg("stripe_secret_key"))


def sales_tax_for(customer, lines, *, inclusive=False, legacy_rate=0, provider=None):
    """Return (TaxResult, source) for a sales document's lines (InvoiceLine objects, unsaved is fine)."""
    exempt = bool(customer.tax_exempt)
    use_stripe = provider == "stripe" or (provider in (None, "", "auto") and stripe_tax_enabled())
    if use_stripe and provider != "codes":
        if exempt:
            res = calculate([TaxLineInput(l.amount_cents, None) for l in lines], inclusive=inclusive)
            res.exempt_cents = res.non_taxable_cents
            res.non_taxable_cents = 0
            return res, "stripe"
        from .online_payments import _client

        default_code = _settings().get("stripe_default_tax_code", "")
        # Stripe's "nontaxable" product tax code keeps lines marked non-taxable out of the calculation
        stripe_lines = [
            (l.amount_cents, "txcd_00000000" if not l.taxable else (db.session.get(Item, l.item_id).stripe_tax_code if l.item_id else ""))
            for l in lines
        ]
        currency = _settings().get("currency", "USD")
        return stripe_tax_calculate(_client(), currency=currency, customer=customer, lines=stripe_lines, inclusive=inclusive, default_tax_code=default_code), "stripe"
    if not any(l.tax_code_id for l in lines) and legacy_rate:
        return _legacy(lines, legacy_rate), "legacy"
    inputs = [TaxLineInput(l.amount_cents, l.tax_code or (db.session.get(TaxCode, l.tax_code_id) if l.tax_code_id else None)) for l in lines]
    return calculate(inputs, inclusive=inclusive, exempt=exempt, direction="sales"), "codes"


def _agency_for_jurisdiction(name):
    agency = TaxAgency.query.filter_by(name=name).first()
    if agency is None:
        agency = TaxAgency(name=name, source="stripe", filing_frequency="quarterly")
        db.session.add(agency)
        db.session.flush()
    return agency.id


def record_doc_tax(doc, details, direction, doc_date):
    """Replace the saved tax snapshot for a document."""
    key = {"Invoice": "invoice_id", "Bill": "bill_id", "Expense": "expense_id"}[type(doc).__name__]
    DocTax.query.filter_by(**{key: doc.id}).delete()
    for d in details:
        agency_id = d.get("agency_id")
        if agency_id is None and d.get("jurisdiction"):
            agency_id = _agency_for_jurisdiction(d["jurisdiction"])
        db.session.add(
            DocTax(
                direction=direction,
                date=doc_date,
                agency_id=agency_id,
                rate_id=d.get("rate_id"),
                name=d.get("name", ""),
                rate=float(d.get("rate_pct") or 0),
                taxable_cents=int(d.get("taxable_cents") or 0),
                tax_cents=int(d.get("tax_cents") or 0),
                **{key: doc.id},
            )
        )
    db.session.flush()


def purchase_tax_for(lines, *, inclusive=False):
    inputs = [TaxLineInput(l.amount_cents, l.tax_code or (db.session.get(TaxCode, l.tax_code_id) if l.tax_code_id else None)) for l in lines]
    return calculate(inputs, inclusive=inclusive, direction="purchases")


def _details_json(res):
    return [
        {
            "agency_id": d.get("agency_id"),
            "rate_id": d.get("rate_id"),
            "name": d["name"],
            "rate": d.get("rate_pct"),
            "taxable": money(d["taxable_cents"]),
            "tax": money(d["tax_cents"]),
        }
        for d in res.details
    ]


@bp.post("/tax/preview")
def tax_preview():
    """Live tax figures for a form that has not been saved yet."""
    data = body()
    direction = data.get("direction", "sales")
    inclusive = bool(data.get("amounts_inclusive"))
    lines = []
    for raw in data.get("lines") or []:
        qty = to_decimal(raw.get("quantity", 1))
        if "amount" in raw and "unit_price" not in raw:
            amount = to_cents(raw.get("amount"), "amount", allow_negative=True)
        else:
            amount = int((qty * to_cents(raw.get("unit_price"), "rate", allow_negative=True)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        code = db.session.get(TaxCode, raw.get("tax_code_id")) if raw.get("tax_code_id") else None
        line = InvoiceLine(amount_cents=amount, tax_code_id=code.id if code else None, item_id=raw.get("item_id") or None, taxable=bool(raw.get("taxable", True)))
        line.tax_code = code
        lines.append(line)
    if direction == "purchases":
        res, source = purchase_tax_for(lines, inclusive=inclusive), "codes"
    else:
        customer = db.session.get(Contact, data.get("customer_id")) if data.get("customer_id") else None
        if customer is None:
            customer = Contact(name="", kind="customer")
        provider = data.get("tax_source")
        if provider in (None, "", "auto") and stripe_tax_enabled() and not data.get("use_provider"):
            # Automatic tax is calculated when the user asks (or on save) to avoid a paid API call per keystroke
            return jsonify({"source": "stripe", "pending": True, "subtotal": money(sum(l.amount_cents for l in lines)), "tax": 0, "total": 0, "lines": [], "details": []})
        res, source = sales_tax_for(customer, lines, inclusive=inclusive, legacy_rate=float(data.get("tax_rate") or 0), provider=provider)
    return jsonify(
        {
            "source": source,
            "subtotal": money(res.subtotal_cents),
            "tax": money(res.tax_cents),
            "total": money(res.total_cents),
            "exempt": money(res.exempt_cents),
            "lines": [{"net": money(n), "tax": money(t or 0)} for n, t in zip(res.line_net, res.line_tax)],
            "details": _details_json(res),
        }
    )


# ---------------------------------------------------------------- agencies, rates and codes


@bp.get("/tax/setup")
def tax_setup():
    from .online_payments import cfg

    s = _settings()
    return jsonify(
        {
            "agencies": [a.to_dict() for a in TaxAgency.query.order_by(TaxAgency.name).all()],
            "rates": [r.to_dict() for r in TaxRate.query.order_by(TaxRate.name).all()],
            "codes": [c.to_dict() for c in TaxCode.query.order_by(TaxCode.name).all()],
            "settings": {
                "tax_provider": s.get("tax_provider", "manual"),
                "default_sales_tax_code_id": s.get("default_sales_tax_code_id", ""),
                "default_purchase_tax_code_id": s.get("default_purchase_tax_code_id", ""),
                "prices_include_tax": s.get("prices_include_tax", "false"),
                "stripe_default_tax_code": s.get("stripe_default_tax_code", ""),
            },
            "stripe_connected": bool(cfg("stripe_secret_key")),
        }
    )


def _apply_agency(agency, data):
    agency.name = required_str(data, "name")
    clash = TaxAgency.query.filter(TaxAgency.name == agency.name, TaxAgency.id != (agency.id or 0)).first()
    if clash:
        raise ApiError("An agency with that name already exists")
    agency.registration_number = opt_str(data, "registration_number")
    freq = data.get("filing_frequency") or "quarterly"
    if freq not in FILING_FREQUENCIES:
        raise ApiError("Filing frequency must be monthly, quarterly or annually")
    agency.filing_frequency = freq
    if "active" in data:
        agency.active = bool(data["active"])


@bp.post("/tax/agencies")
def create_agency():
    agency = TaxAgency()
    _apply_agency(agency, body())
    db.session.add(agency)
    db.session.commit()
    return jsonify(agency.to_dict()), 201


@bp.put("/tax/agencies/<int:agency_id>")
def update_agency(agency_id):
    agency = get_or_404(TaxAgency, agency_id, "Agency")
    _apply_agency(agency, body())
    db.session.commit()
    return jsonify(agency.to_dict())


@bp.delete("/tax/agencies/<int:agency_id>")
def delete_agency(agency_id):
    agency = get_or_404(TaxAgency, agency_id, "Agency")
    if TaxRate.query.filter_by(agency_id=agency.id).first() or DocTax.query.filter_by(agency_id=agency.id).first() or TaxPayment.query.filter_by(agency_id=agency.id).first():
        raise ApiError("This agency has rates or tax history. Make it inactive instead.")
    db.session.delete(agency)
    db.session.commit()
    return jsonify({"ok": True})


def _apply_rate(rate, data):
    rate.name = required_str(data, "name")
    agency = db.session.get(TaxAgency, data.get("agency_id"))
    if agency is None:
        raise ApiError("Choose the agency this rate is paid to")
    rate.agency_id = agency.id
    try:
        value = float(data.get("rate"))
    except (TypeError, ValueError):
        raise ApiError("The rate must be a number")
    if not 0 <= value <= 100:
        raise ApiError("The rate must be between 0 and 100")
    rate.rate = value
    applies = data.get("applies_to") or "sales"
    if applies not in ("sales", "purchases", "both"):
        raise ApiError("Applies to must be sales, purchases or both")
    rate.applies_to = applies
    if "active" in data:
        rate.active = bool(data["active"])


@bp.post("/tax/rates")
def create_rate():
    rate = TaxRate()
    _apply_rate(rate, body())
    db.session.add(rate)
    db.session.commit()
    return jsonify(rate.to_dict()), 201


@bp.put("/tax/rates/<int:rate_id>")
def update_rate(rate_id):
    rate = get_or_404(TaxRate, rate_id, "Rate")
    _apply_rate(rate, body())
    db.session.commit()
    return jsonify(rate.to_dict())


@bp.delete("/tax/rates/<int:rate_id>")
def delete_rate(rate_id):
    rate = get_or_404(TaxRate, rate_id, "Rate")
    if DocTax.query.filter_by(rate_id=rate.id).first():
        raise ApiError("This rate has been used on transactions. Make it inactive instead.")
    for code in TaxCode.query.all():
        if rate in code.rates:
            code.rates.remove(rate)
    db.session.delete(rate)
    db.session.commit()
    return jsonify({"ok": True})


def _apply_code(code, data):
    code.name = required_str(data, "name")
    clash = TaxCode.query.filter(TaxCode.name == code.name, TaxCode.id != (code.id or 0)).first()
    if clash:
        raise ApiError("A tax code with that name already exists")
    code.description = opt_str(data, "description")
    ids = [int(i) for i in data.get("rate_ids") or []]
    rates = TaxRate.query.filter(TaxRate.id.in_(ids)).all() if ids else []
    if len(rates) != len(set(ids)):
        raise ApiError("Unknown rate in this tax code")
    code.rates = rates
    if "active" in data:
        code.active = bool(data["active"])


@bp.post("/tax/codes")
def create_code():
    code = TaxCode()
    _apply_code(code, body())
    db.session.add(code)
    db.session.commit()
    return jsonify(code.to_dict()), 201


@bp.put("/tax/codes/<int:code_id>")
def update_code(code_id):
    code = get_or_404(TaxCode, code_id, "Tax code")
    _apply_code(code, body())
    db.session.commit()
    return jsonify(code.to_dict())


@bp.delete("/tax/codes/<int:code_id>")
def delete_code(code_id):
    code = get_or_404(TaxCode, code_id, "Tax code")
    used = (
        InvoiceLine.query.filter_by(tax_code_id=code.id).first()
        or BillLine.query.filter_by(tax_code_id=code.id).first()
        or ExpenseLine.query.filter_by(tax_code_id=code.id).first()
    )
    if used:
        raise ApiError("This tax code is used on transactions. Make it inactive instead.")
    db.session.delete(code)
    db.session.commit()
    return jsonify({"ok": True})


@bp.put("/tax/settings")
def update_tax_settings():
    require_admin()
    from .settings import set_setting

    data = body()
    if "tax_provider" in data:
        if data["tax_provider"] not in PROVIDERS:
            raise ApiError("Unknown tax provider")
        if data["tax_provider"] == "stripe_tax":
            from .online_payments import cfg

            if not cfg("stripe_secret_key"):
                raise ApiError("Connect Stripe in Settings → Online payments before using Stripe Tax")
        set_setting("tax_provider", data["tax_provider"])
    for key in ("default_sales_tax_code_id", "default_purchase_tax_code_id"):
        if key in data:
            value = data[key] or ""
            if value and db.session.get(TaxCode, int(value)) is None:
                raise ApiError("Unknown tax code")
            set_setting(key, str(value))
    if "prices_include_tax" in data:
        set_setting("prices_include_tax", "true" if data["prices_include_tax"] in (True, "true") else "false")
    if "stripe_default_tax_code" in data:
        code = opt_str(data, "stripe_default_tax_code")
        if code and not code.startswith("txcd_"):
            raise ApiError("Stripe product tax codes look like txcd_10000000")
        set_setting("stripe_default_tax_code", code)
    db.session.commit()
    return tax_setup()


# Templates use each country's standard national rates as a starting point; local
# rates (US states, counties and cities) must be entered for where you are registered.
TEMPLATES = {
    "us_local": {
        "label": "United States – state + local sales tax (enter your rates)",
        "agencies": [("State Department of Revenue", "quarterly")],
        "rates": [],
        "codes": [],
    },
    "uk_vat": {
        "label": "United Kingdom – VAT 20% / 5% / 0%",
        "agencies": [("HM Revenue & Customs", "quarterly")],
        "rates": [("VAT 20%", 0, 20.0), ("VAT 5%", 0, 5.0), ("VAT 0%", 0, 0.0)],
        "codes": [("Standard 20%", [0]), ("Reduced 5%", [1]), ("Zero rated", [2])],
    },
    "ca_gst": {
        "label": "Canada – GST 5% (add PST/QST, or use HST 13%/15% in HST provinces)",
        "agencies": [("Canada Revenue Agency", "quarterly")],
        "rates": [("GST 5%", 0, 5.0), ("HST 13%", 0, 13.0), ("HST 15%", 0, 15.0)],
        "codes": [("GST", [0]), ("HST ON", [1]), ("HST 15%", [2])],
    },
    "au_gst": {
        "label": "Australia – GST 10%",
        "agencies": [("Australian Taxation Office", "quarterly")],
        "rates": [("GST 10%", 0, 10.0)],
        "codes": [("GST", [0]), ("GST free", [])],
    },
    "nz_gst": {
        "label": "New Zealand – GST 15%",
        "agencies": [("Inland Revenue", "monthly")],
        "rates": [("GST 15%", 0, 15.0)],
        "codes": [("GST", [0]), ("Zero rated", [])],
    },
}


@bp.get("/tax/templates")
def tax_templates():
    return jsonify([{"key": k, "label": v["label"]} for k, v in TEMPLATES.items()])


@bp.post("/tax/templates/<key>")
def apply_template(key):
    if key not in TEMPLATES:
        raise ApiError("Unknown template", 404)
    t = TEMPLATES[key]
    vat_style = key != "us_local"
    agencies = []
    for name, freq in t["agencies"]:
        agency = TaxAgency.query.filter_by(name=name).first() or TaxAgency(name=name, filing_frequency=freq)
        db.session.add(agency)
        agencies.append(agency)
    db.session.flush()
    rates = []
    for name, agency_idx, pct in t["rates"]:
        rate = TaxRate.query.filter_by(name=name, agency_id=agencies[agency_idx].id).first() or TaxRate(
            name=name, agency_id=agencies[agency_idx].id, rate=pct, applies_to="both" if vat_style else "sales"
        )
        db.session.add(rate)
        rates.append(rate)
    db.session.flush()
    for name, idxs in t["codes"]:
        if not TaxCode.query.filter_by(name=name).first():
            db.session.add(TaxCode(name=name, rates=[rates[i] for i in idxs]))
    db.session.commit()
    return tax_setup()


# ---------------------------------------------------------------- liability, periods, payments


def _sum_tax(agency_id, direction, start=None, end=None):
    q = db.session.query(func.coalesce(func.sum(DocTax.tax_cents), 0), func.coalesce(func.sum(DocTax.taxable_cents), 0)).filter(DocTax.direction == direction)
    q = q.filter(DocTax.agency_id == agency_id) if agency_id is not None else q.filter(DocTax.agency_id.is_(None))
    if start:
        q = q.filter(DocTax.date >= start)
    if end:
        q = q.filter(DocTax.date <= end)
    tax, taxable = q.one()
    return int(tax), int(taxable)


def _paid(agency_id, start=None, end=None):
    q = db.session.query(func.coalesce(func.sum(TaxPayment.amount_cents), 0)).filter(TaxPayment.agency_id == agency_id)
    if start and end:
        # payments filed for periods inside this range
        q = q.filter(TaxPayment.period_end >= start, TaxPayment.period_start <= end)
    return int(q.scalar())


def period_bounds(freq, ref):
    if freq == "monthly":
        start = date(ref.year, ref.month, 1)
        end = (date(ref.year + (ref.month == 12), ref.month % 12 + 1, 1)) - timedelta(days=1)
    elif freq == "annually":
        start, end = date(ref.year, 1, 1), date(ref.year, 12, 31)
    else:
        q0 = (ref.month - 1) // 3 * 3 + 1
        start = date(ref.year, q0, 1)
        end = (date(ref.year + (q0 == 10), (q0 + 2) % 12 + 1, 1)) - timedelta(days=1)
    return start, end


def _periods(freq, count=6):
    out, ref = [], date.today()
    for _ in range(count):
        start, end = period_bounds(freq, ref)
        out.append((start, end))
        ref = start - timedelta(days=1)
    return out


@bp.get("/tax/overview")
def tax_overview():
    agencies = []
    for a in TaxAgency.query.order_by(TaxAgency.name).all():
        collected, _ = _sum_tax(a.id, "sales")
        input_tax, _ = _sum_tax(a.id, "purchases")
        paid = _paid(a.id)
        periods = []
        for start, end in _periods(a.filing_frequency):
            s_tax, s_taxable = _sum_tax(a.id, "sales", start, end)
            p_tax, _ = _sum_tax(a.id, "purchases", start, end)
            p_paid = _paid(a.id, start, end)
            due = s_tax - p_tax
            periods.append(
                {
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "taxable_sales": money(s_taxable),
                    "tax_collected": money(s_tax),
                    "input_tax": money(p_tax),
                    "net_due": money(due),
                    "paid": money(p_paid),
                    "status": "open"
                    if end >= date.today()
                    else "filed"
                    if TaxPayment.query.filter_by(agency_id=a.id, period_start=start, period_end=end).first()
                    else "nothing_due"
                    if due == 0
                    else "due",
                }
            )
        if not a.active and not (collected or input_tax or paid):
            continue
        agencies.append({**a.to_dict(), "balance": money(collected - input_tax - paid), "periods": periods})
    legacy, _ = _sum_tax(None, "sales")
    return jsonify({"agencies": agencies, "unassigned_tax": money(legacy), "payments": [p.to_dict() for p in TaxPayment.query.order_by(TaxPayment.date.desc()).limit(50).all()]})


@bp.get("/tax/liability")
def tax_liability():
    end = arg_date("end", date.today())
    start = arg_date("start", date(end.year, 1, 1))
    agency_ids = [a.id for a in TaxAgency.query.all()] + [None]
    rows = []
    for aid in agency_ids:
        q = DocTax.query.filter(DocTax.date >= start, DocTax.date <= end)
        q = q.filter(DocTax.agency_id == aid) if aid is not None else q.filter(DocTax.agency_id.is_(None))
        entries = q.all()
        paid = _paid(aid, start, end) if aid is not None else 0
        if not entries and not paid:
            continue
        by_rate = {}
        for e in entries:
            k = (e.name, e.rate, e.direction)
            r = by_rate.setdefault(k, {"name": e.name, "rate": e.rate, "direction": e.direction, "taxable": 0, "tax": 0})
            r["taxable"] += e.taxable_cents
            r["tax"] += e.tax_cents
        collected = sum(e.tax_cents for e in entries if e.direction == "sales")
        input_tax = sum(e.tax_cents for e in entries if e.direction == "purchases")
        agency = db.session.get(TaxAgency, aid) if aid else None
        rows.append(
            {
                "agency_id": aid,
                "agency": agency.name if agency else "Unassigned (older flat-rate invoices)",
                "rates": [{**r, "taxable": money(r["taxable"]), "tax": money(r["tax"])} for r in sorted(by_rate.values(), key=lambda r: (r["direction"], r["name"]))],
                "tax_collected": money(collected),
                "input_tax": money(input_tax),
                "net": money(collected - input_tax),
                "paid": money(paid),
                "balance": money(collected - input_tax - paid),
            }
        )
    # sales totals for the period: taxable vs non-taxable vs exempt
    invoices = Invoice.query.filter(Invoice.kind.in_(("invoice", "sales_receipt")), Invoice.status.notin_(("draft", "void")), Invoice.date >= start, Invoice.date <= end).all()
    total_sales = sum(i.subtotal_cents for i in invoices)
    exempt_sales = sum(i.subtotal_cents for i in invoices if i.customer.tax_exempt)
    taxable_sales = sum(int(sum(l.net_cents if l.net_cents is not None else l.amount_cents for l in i.lines if (l.tax_code_id or (i.tax_source == "legacy" and l.taxable and i.tax_rate)))) for i in invoices if not i.customer.tax_exempt)
    taxable_sales += sum(i.subtotal_cents for i in invoices if i.tax_source == "stripe" and i.tax_cents and not i.customer.tax_exempt)
    return jsonify(
        {
            "title": "Sales Tax Liability",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "agencies": rows,
            "totals": {
                "total_sales": money(total_sales),
                "taxable_sales": money(taxable_sales),
                "non_taxable_sales": money(total_sales - taxable_sales - exempt_sales),
                "exempt_sales": money(exempt_sales),
                "tax_collected": money(sum(r["tax_collected"] * 100 for r in rows) / 100),
                "input_tax": money(sum(r["input_tax"] * 100 for r in rows) / 100),
                "net": money(sum(r["net"] * 100 for r in rows) / 100),
            },
        }
    )


@bp.post("/tax/payments")
def record_tax_payment():
    data = body()
    agency = get_or_404(TaxAgency, data.get("agency_id"), "Agency")
    start = parse_date(data.get("period_start"), "period start")
    end = parse_date(data.get("period_end"), "period end")
    if end < start:
        raise ApiError("The period ends before it starts")
    amount = to_cents(data.get("amount"), "amount", allow_negative=True, allow_zero=False)
    account = db.session.get(Account, data.get("account_id"))
    if account is None or account.subtype not in ("bank", "cash", "credit_card"):
        raise ApiError("Choose the bank account the payment was made from (or the refund went to)")
    payment = TaxPayment(
        agency_id=agency.id,
        period_start=start,
        period_end=end,
        date=parse_date(data.get("date"), "payment date"),
        amount_cents=amount,
        account_id=account.id,
        reference=opt_str(data, "reference"),
        memo=opt_str(data, "memo"),
    )
    db.session.add(payment)
    db.session.flush()
    liability = system_account(SUBTYPE_SALES_TAX)
    lines = (
        [{"account_id": liability.id, "debit": amount}, {"account_id": account.id, "credit": amount}]
        if amount > 0
        else [{"account_id": account.id, "debit": -amount}, {"account_id": liability.id, "credit": -amount}]
    )
    entry = post_entry(
        date=payment.date,
        memo=f"{'Tax payment to' if amount > 0 else 'Tax refund from'} {agency.name} ({start.isoformat()} – {end.isoformat()})",
        reference=payment.reference,
        source_type="tax_payment",
        source_id=payment.id,
        lines=lines,
    )
    payment.journal_entry_id = entry.id
    db.session.commit()
    return jsonify(payment.to_dict()), 201


@bp.delete("/tax/payments/<int:payment_id>")
def delete_tax_payment(payment_id):
    payment = get_or_404(TaxPayment, payment_id, "Tax payment")
    delete_entry(payment.journal_entry_id)
    db.session.delete(payment)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- company-wide tax method

TAX_METHODS = ("manual", "us_tables", "stripe_tax")


def _stored_setting(key):
    from ..models import Setting

    row = db.session.get(Setting, key)
    return row.value if row else None


def tax_method():
    """manual | us_tables | stripe_tax. Older installs are derived from their existing settings."""
    method = _stored_setting("tax_method")
    if method in TAX_METHODS:
        return method
    if _settings().get("tax_provider") == "stripe_tax":
        return "stripe_tax"
    from ..models import Employee

    return "us_tables" if Employee.query.filter_by(withholding_method="tables").first() else "manual"


def payroll_default_method():
    """Withholding method for new employees under the chosen tax method."""
    method = tax_method()
    if method == "us_tables":
        return "tables"
    if method == "manual":
        return "percent"
    stored = _stored_setting("payroll_withholding_default")
    return stored if stored in ("percent", "tables") else "percent"


def _method_payload():
    from datetime import date as _date

    from ..models import Employee, PayrollTaxTable
    from .online_payments import cfg

    year = _date.today().year
    tables = PayrollTaxTable.query.filter_by(tax_year=year).all()
    s = _settings()
    return {
        "method": tax_method(),
        "payroll_default": payroll_default_method(),
        "stripe_connected": bool(cfg("stripe_secret_key")),
        "stripe_default_tax_code": s.get("stripe_default_tax_code", ""),
        "default_sales_tax_code_id": s.get("default_sales_tax_code_id", ""),
        "default_purchase_tax_code_id": s.get("default_purchase_tax_code_id", ""),
        "prices_include_tax": s.get("prices_include_tax", "false"),
        "codes": [{"id": c.id, "label": c.to_dict()["label"], "purchase_rate": c.total_rate("purchases")} for c in TaxCode.query.filter_by(active=True).order_by(TaxCode.name).all()],
        "payroll_tables": {
            "year": year,
            "count": len(tables),
            "unverified": sum(1 for t in tables if not t.verified),
            "has_federal": any(t.jurisdiction == "US-FED" and t.kind == "income_tax" for t in tables),
        },
        "employees": {
            "tables": Employee.query.filter_by(active=True, withholding_method="tables").count(),
            "percent": Employee.query.filter_by(active=True, withholding_method="percent").count(),
        },
    }


@bp.get("/tax/method")
def get_tax_method():
    return jsonify(_method_payload())


@bp.put("/tax/method")
def set_tax_method():
    """Choose how taxes are calculated and save that method's settings in one step."""
    require_admin()
    from ..models import Employee
    from .online_payments import cfg
    from .settings import set_setting

    data = body()
    method = data.get("method") or tax_method()
    if method not in TAX_METHODS:
        raise ApiError("Choose manual, US tables or a third-party tax service")
    if method == "stripe_tax" and not cfg("stripe_secret_key"):
        raise ApiError("Connect Stripe under Online payments before choosing Stripe Tax")
    set_setting("tax_method", method)
    set_setting("tax_provider", "stripe_tax" if method == "stripe_tax" else "manual")
    if method == "stripe_tax" and data.get("payroll_default") in ("percent", "tables"):
        set_setting("payroll_withholding_default", data["payroll_default"])

    for key in ("default_sales_tax_code_id", "default_purchase_tax_code_id"):
        if key in data:
            value = data[key] or ""
            if value and db.session.get(TaxCode, int(value)) is None:
                raise ApiError("Unknown tax code")
            set_setting(key, str(value))
    if "prices_include_tax" in data:
        set_setting("prices_include_tax", "true" if data["prices_include_tax"] in (True, "true") else "false")
    if "stripe_default_tax_code" in data:
        code = opt_str(data, "stripe_default_tax_code")
        if code and not code.startswith("txcd_"):
            raise ApiError("Stripe product tax codes look like txcd_10000000")
        set_setting("stripe_default_tax_code", code)
    db.session.flush()
    switched = 0
    if data.get("apply_to_employees"):
        target = payroll_default_method()
        for emp in Employee.query.filter_by(active=True).all():
            if emp.withholding_method != target:
                emp.withholding_method = target
                switched += 1
    db.session.commit()
    return jsonify({**_method_payload(), "employees_switched": switched})
