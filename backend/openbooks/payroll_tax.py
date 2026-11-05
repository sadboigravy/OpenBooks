"""Payroll tax calculation from tax tables.

Federal income tax withholding follows the structure of the IRS annual
percentage method for Forms W-4 from 2020 or later (Publication 15-T,
Worksheet 1A):

  1. annualise the period's wages and add W-4 Step 4(a) other income
  2. subtract Step 4(b) deductions and, when the Step 2 box is NOT checked,
     the fixed allowance (12,900 married filing jointly / 8,600 otherwise)
  3. look up tentative annual tax: the first part of income is untaxed
     (standard deduction minus the allowance, or half the standard deduction
     when Step 2 is checked) and the rest uses the year's tax brackets
     (bracket widths halved when Step 2 is checked)
  4. subtract the Step 3 dependents credit, divide by pay periods and add
     Step 4(c) extra withholding

Tax tables are data. The built-in figures below are a starting point and are
marked unverified until an administrator confirms them against the official
sources for the year; the person running payroll is responsible for using
correct, current tables.
"""
from decimal import ROUND_HALF_UP, Decimal

FILING_STATUSES = ("single", "married_jointly", "head_of_household")

# W-4 (2020+) worksheet allowance when the Step 2 checkbox is not checked
W4_ALLOWANCE = {"married_jointly": 12900, "single": 8600, "head_of_household": 8600}

RATES = [10, 12, 22, 24, 32, 35, 37]

# Built-in starting data. Brackets are the upper limit of taxable income for
# each rate except the last (37%), in whole dollars.
BUILTIN_FEDERAL = {
    2025: {
        "source": "IRS Rev. Proc. 2024-40 as amended by Public Law 119-21 (2025); Publication 15-T (2025)",
        "standard_deduction": {"single": 15750, "married_jointly": 31500, "head_of_household": 23625},
        "brackets": {
            "single": [11925, 48475, 103350, 197300, 250525, 626350],
            "married_jointly": [23850, 96950, 206700, 394600, 501050, 751600],
            "head_of_household": [17000, 64850, 103350, 197300, 250500, 626350],
        },
        "social_security": {"rate": 6.2, "wage_base": 176100},
        "medicare": {"rate": 1.45, "additional_rate": 0.9, "additional_threshold": 200000},
        "futa": {"rate": 0.6, "wage_base": 7000, "note": "6.0% less the 5.4% state credit; higher in credit-reduction states"},
    },
    2026: {
        "source": "IRS Rev. Proc. 2025-32; Publication 15-T (2026); SSA 2026 contribution and benefit base",
        "standard_deduction": {"single": 16100, "married_jointly": 32200, "head_of_household": 24150},
        "brackets": {
            "single": [12400, 50400, 105700, 201775, 256225, 640600],
            "married_jointly": [24800, 100800, 211400, 403550, 512450, 768700],
            "head_of_household": [17700, 67450, 105700, 201750, 256200, 640600],
        },
        "social_security": {"rate": 6.2, "wage_base": 184500},
        "medicare": {"rate": 1.45, "additional_rate": 0.9, "additional_threshold": 200000},
        "futa": {"rate": 0.6, "wage_base": 7000, "note": "6.0% less the 5.4% state credit; higher in credit-reduction states"},
    },
}

# States with no state income tax on wages (state withholding is zero)
NO_WAGE_TAX_STATES = ["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"]


def _d(x):
    return Decimal(str(x))


def cents(value):
    return int(_d(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def progressive_tax(amount, limits, rates):
    """Tax on `amount` (Decimal dollars) with bracket upper `limits` and percent `rates` (len(rates) == len(limits)+1)."""
    tax, lower = Decimal(0), Decimal(0)
    for i, rate in enumerate(rates):
        upper = _d(limits[i]) if i < len(limits) else None
        if amount <= lower:
            break
        top = amount if upper is None else min(amount, upper)
        tax += (top - lower) * _d(rate) / 100
        if upper is None or amount <= upper:
            break
        lower = upper
    return tax


def federal_withholding(table, *, wages_cents, periods, filing_status="single", multiple_jobs=False, dependents_cents=0, other_income_cents=0, deductions_cents=0, extra_cents=0):
    """Federal income tax to withhold this period, in cents."""
    if filing_status not in FILING_STATUSES:
        filing_status = "single"
    annual = _d(wages_cents) / 100 * periods + _d(other_income_cents) / 100 - _d(deductions_cents) / 100
    std = _d(table["standard_deduction"][filing_status])
    limits = [_d(x) for x in table["brackets"][filing_status]]
    if multiple_jobs:
        zero = std / 2
        limits = [x / 2 for x in limits]
    else:
        annual -= _d(W4_ALLOWANCE[filing_status])
        zero = std - _d(W4_ALLOWANCE[filing_status])
    taxable = max(Decimal(0), annual - zero)
    annual_tax = progressive_tax(taxable, limits, table.get("rates", RATES))
    annual_tax = max(Decimal(0), annual_tax - _d(dependents_cents) / 100)
    per_period = annual_tax / periods
    return max(0, cents(per_period * 100) + int(extra_cents))


def state_withholding(table, *, wages_cents, periods, filing_status="single", allowances=0, extra_cents=0):
    """State income tax withholding from a state table: method none, flat or brackets."""
    method = (table or {}).get("method", "none")
    if method == "none":
        return int(extra_cents)
    annual = _d(wages_cents) / 100 * periods
    annual -= _d(table.get("allowance_per_exemption", 0)) * int(allowances or 0)
    if method == "flat":
        annual -= _d(table.get("standard_deduction", 0))
        tax = max(Decimal(0), annual) * _d(table.get("rate", 0)) / 100
    else:
        status = filing_status if filing_status in table.get("brackets", {}) else "single"
        annual -= _d(table.get("standard_deduction", {}).get(status, 0)) if isinstance(table.get("standard_deduction"), dict) else _d(table.get("standard_deduction", 0))
        tax = progressive_tax(max(Decimal(0), annual), table["brackets"][status], table["rates"])
    return max(0, cents(tax / periods * 100) + int(extra_cents))


def fica(table_ss, table_medicare, *, wages_cents, ytd_wages_cents):
    """Employee and employer social security / Medicare for this paycheck, in cents."""
    out = {"ss_employee": 0, "ss_employer": 0, "medicare_employee": 0, "medicare_employer": 0, "addl_medicare": 0}
    if table_ss:
        base = int(_d(table_ss["wage_base"]) * 100)
        taxable = max(0, min(wages_cents, base - ytd_wages_cents))
        amt = cents(_d(taxable) * _d(table_ss["rate"]) / 100)
        out["ss_employee"] = out["ss_employer"] = amt
    if table_medicare:
        amt = cents(_d(wages_cents) * _d(table_medicare["rate"]) / 100)
        out["medicare_employee"] = out["medicare_employer"] = amt
        threshold = int(_d(table_medicare.get("additional_threshold", 0)) * 100)
        if threshold and table_medicare.get("additional_rate"):
            over = max(0, ytd_wages_cents + wages_cents - max(threshold, ytd_wages_cents))
            out["addl_medicare"] = cents(_d(over) * _d(table_medicare["additional_rate"]) / 100)
    return out


def unemployment(table, *, wages_cents, ytd_wages_cents):
    """Employer FUTA or SUTA on wages up to the annual wage base."""
    if not table:
        return 0
    base = int(_d(table.get("wage_base", 0)) * 100)
    taxable = max(0, min(wages_cents, base - ytd_wages_cents)) if base else wages_cents
    return cents(_d(taxable) * _d(table.get("rate", 0)) / 100)


def builtin_tables():
    """(tax_year, jurisdiction, kind, name, data, source) for the built-in starting data."""
    out = []
    for year, t in BUILTIN_FEDERAL.items():
        src = t["source"]
        out.append((year, "US-FED", "income_tax", f"Federal income tax withholding {year}", {"method": "w4_2020", "standard_deduction": t["standard_deduction"], "brackets": t["brackets"], "rates": RATES}, src))
        out.append((year, "US-FED", "social_security", f"Social security {year}", t["social_security"], src))
        out.append((year, "US-FED", "medicare", f"Medicare {year}", t["medicare"], src))
        out.append((year, "US-FED", "futa", f"Federal unemployment (FUTA) {year}", t["futa"], src))
        for st in NO_WAGE_TAX_STATES:
            out.append((year, f"US-{st}", "income_tax", f"{st} income tax {year} (no wage income tax)", {"method": "none"}, "State has no income tax on wages"))
    return out
