"""Sales tax / VAT / GST calculation.

`calculate()` is a pure function: it takes document lines (amount in cents and
the tax code chosen for the line) and returns the tax per line and per
component rate. Rounding is done once per component rate on the document
total (the usual rule for invoices), and for tax-inclusive prices the line's
tax is split across component rates with the remainder going to the last one,
so the parts always add up exactly.

Automatic calculation through Stripe Tax lives in `stripe_tax_calculate()`.
"""
import logging
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from .util import ApiError

log = logging.getLogger("openbooks.tax")


def _round(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


@dataclass
class TaxLineInput:
    amount_cents: int  # as entered (inclusive or exclusive of tax)
    tax_code: object = None  # TaxCode or None (not taxable / out of scope)


@dataclass
class TaxResult:
    line_net: list = field(default_factory=list)  # net amount per input line
    line_tax: list = field(default_factory=list)  # tax per input line
    details: list = field(default_factory=list)  # [{rate, agency_id, rate_id, name, rate_pct, taxable_cents, tax_cents}]
    subtotal_cents: int = 0  # sum of net amounts
    tax_cents: int = 0
    total_cents: int = 0
    exempt_cents: int = 0  # taxable lines not taxed because the customer is exempt
    non_taxable_cents: int = 0  # lines without a tax code


def calculate(lines, *, inclusive=False, exempt=False, direction="sales"):
    result = TaxResult()
    by_rate = {}  # rate_id -> detail dict
    for line in lines:
        amount = int(line.amount_cents)
        rates = line.tax_code.rates_for(direction) if line.tax_code is not None else []
        if not rates or exempt:
            if rates and exempt:
                result.exempt_cents += amount
            elif not rates:
                result.non_taxable_cents += amount
            result.line_net.append(amount)
            result.line_tax.append(0)
            continue
        combined = sum(Decimal(str(r.rate)) for r in rates)
        if inclusive and combined:
            net = _round(Decimal(amount) * 100 / (100 + combined))
            line_tax = amount - net
            # split this line's tax across component rates in proportion to their rate
            parts, given = [], 0
            for i, r in enumerate(rates):
                if i == len(rates) - 1:
                    parts.append(line_tax - given)
                else:
                    share = _round(Decimal(line_tax) * Decimal(str(r.rate)) / combined)
                    parts.append(share)
                    given += share
        else:
            net = amount
            parts = None  # computed per rate on the document total below
        result.line_net.append(net)
        result.line_tax.append(line_tax if inclusive and combined else None)
        for i, r in enumerate(rates):
            d = by_rate.setdefault(
                r.id,
                {"rate": r, "agency_id": r.agency_id, "rate_id": r.id, "name": r.name, "rate_pct": r.rate, "taxable_cents": 0, "tax_cents": 0},
            )
            d["taxable_cents"] += net
            if parts is not None:
                d["tax_cents"] += parts[i]

    if not inclusive:
        # exclusive pricing: tax = rounded(rate × taxable total) per component
        for d in by_rate.values():
            d["tax_cents"] = _round(Decimal(d["taxable_cents"]) * Decimal(str(d["rate_pct"])) / 100)
        # per-line tax for display, allocated so the lines add up to the document tax
        _allocate_line_tax(lines, result, by_rate, direction, exempt)

    result.details = [d for d in by_rate.values() if d["taxable_cents"] or d["tax_cents"]]
    result.subtotal_cents = sum(result.line_net)
    result.tax_cents = sum(d["tax_cents"] for d in result.details)
    result.total_cents = result.subtotal_cents + result.tax_cents
    return result


def _allocate_line_tax(lines, result, by_rate, direction, exempt):
    remaining = {rid: d["tax_cents"] for rid, d in by_rate.items()}
    taxable_left = {rid: d["taxable_cents"] for rid, d in by_rate.items()}
    for idx, line in enumerate(lines):
        if result.line_tax[idx] is not None:
            continue
        rates = line.tax_code.rates_for(direction) if line.tax_code is not None and not exempt else []
        tax = 0
        for r in rates:
            base = taxable_left[r.id]
            share = remaining[r.id] if base == line.amount_cents else (_round(Decimal(remaining[r.id]) * line.amount_cents / base) if base else 0)
            remaining[r.id] -= share
            taxable_left[r.id] -= line.amount_cents
            tax += share
        result.line_tax[idx] = tax


# ---------------------------------------------------------------- Stripe Tax (optional provider)

ZERO_DECIMAL = {"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"}


def stripe_tax_calculate(client, *, currency, customer, lines, inclusive, default_tax_code=""):
    """Ask Stripe Tax for the tax on a sale, based on the customer's address.

    `lines` is a list of (amount_cents, stripe_tax_code_or_empty). Returns a
    TaxResult whose details carry a `jurisdiction` instead of a local rate.
    """
    import stripe

    currency = currency.lower()
    if not (customer.country and (customer.postal_code or customer.address_line1)):
        raise ApiError(f"Add a country and postal code to {customer.name}'s address so tax can be calculated automatically")
    divisor = 100 if currency in ZERO_DECIMAL else 1
    params = {
        "currency": currency,
        "customer_details": {
            "address": {
                k: v
                for k, v in {
                    "line1": customer.address_line1,
                    "city": customer.city,
                    "state": customer.region,
                    "postal_code": customer.postal_code,
                    "country": customer.country.upper(),
                }.items()
                if v
            },
            "address_source": "billing",
        },
        "line_items": [
            {
                "amount": int(amount) // divisor,
                "reference": f"line-{i}",
                "tax_behavior": "inclusive" if inclusive else "exclusive",
                **({"tax_code": code or default_tax_code} if (code or default_tax_code) else {}),
            }
            for i, (amount, code) in enumerate(lines)
        ],
        "expand": ["line_items"],
    }
    try:
        calc = client.tax.calculations.create(params=params)
    except stripe.error.InvalidRequestError as exc:
        raise ApiError(f"Stripe Tax could not calculate tax: {exc.user_message or exc}")
    except stripe.error.StripeError as exc:
        log.warning("Stripe Tax error: %s", exc)
        raise ApiError("Automatic tax calculation is unavailable right now. Try again, or switch this document to manual tax codes.", 502)

    result = TaxResult()
    by_key = {}
    items = (calc.get("line_items") or {}).get("data") or []
    items_by_ref = {it.get("reference"): it for it in items}
    for i, (amount, _code) in enumerate(lines):
        item = items_by_ref.get(f"line-{i}") or {}
        tax = int(item.get("amount_tax") or 0) * divisor
        result.line_tax.append(tax)
        result.line_net.append(int(amount) - tax if inclusive else int(amount))
        for b in item.get("tax_breakdown") or []:
            j = b.get("jurisdiction") or {}
            details = b.get("tax_rate_details") or {}
            pct = float(details.get("percentage_decimal") or 0)
            name = j.get("display_name") or j.get("state") or j.get("country") or "Tax"
            key = (name, j.get("level"), details.get("tax_type"), pct)
            d = by_key.setdefault(
                key,
                {
                    "rate": None,
                    "agency_id": None,
                    "rate_id": None,
                    "jurisdiction": name,
                    "name": f"{name} {(details.get('tax_type') or 'tax').replace('_', ' ')}",
                    "rate_pct": pct,
                    "taxable_cents": 0,
                    "tax_cents": 0,
                },
            )
            d["taxable_cents"] += int(b.get("taxable_amount") or 0) * divisor
            d["tax_cents"] += int(b.get("amount") or 0) * divisor
    result.details = [d for d in by_key.values() if d["tax_cents"] or d["taxable_cents"]]
    result.subtotal_cents = sum(result.line_net)
    result.tax_cents = sum(result.line_tax)
    result.total_cents = result.subtotal_cents + result.tax_cents
    return result
