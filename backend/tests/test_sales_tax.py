import sqlite3
from types import SimpleNamespace as NS

import pytest

from openbooks import create_app
from openbooks.tax import TaxLineInput, calculate
from tests.test_api import acct


# ---------------------------------------------------------------- pure engine


def _code(*pairs, applies="sales"):
    rates = [NS(id=i + 1, agency_id=10 + i, name=n, rate=r, applies_to=applies) for i, (n, r) in enumerate(pairs)]
    return NS(rates_for=lambda direction: [r for r in rates if r.applies_to in (direction, "both")])


def test_exclusive_combined_rate_rounds_per_component():
    seattle = _code(("State", 6.5), ("County", 0.5), ("City", 3.35))
    res = calculate([TaxLineInput(10000, seattle), TaxLineInput(3333, seattle), TaxLineInput(500, None)])
    assert res.subtotal_cents == 13833
    by_name = {d["name"]: d for d in res.details}
    assert by_name["State"]["taxable_cents"] == 13333
    assert by_name["State"]["tax_cents"] == 867  # 866.645 -> 867
    assert by_name["County"]["tax_cents"] == 67  # 66.665 -> 67
    assert by_name["City"]["tax_cents"] == 447  # 446.66 -> 447
    assert res.tax_cents == 867 + 67 + 447
    assert sum(res.line_tax) == res.tax_cents  # per-line display adds up exactly
    assert res.non_taxable_cents == 500


def test_inclusive_prices_back_out_tax_exactly():
    vat = _code(("VAT 20%", 20.0))
    res = calculate([TaxLineInput(1200, vat), TaxLineInput(999, vat)], inclusive=True)
    assert res.line_net == [1000, 833]  # 999/1.2 = 832.5 -> 833
    assert res.line_tax == [200, 166]
    assert res.total_cents == 2199  # inclusive total equals what was entered
    assert res.tax_cents == 366


def test_inclusive_split_across_components_adds_up():
    code = _code(("GST", 5.0), ("PST", 7.0))
    res = calculate([TaxLineInput(1000, code)], inclusive=True)
    assert res.line_net == [893]
    assert sum(d["tax_cents"] for d in res.details) == 107 == res.tax_cents


def test_exempt_customer_and_purchase_direction():
    code = _code(("Sales only", 8.0))
    res = calculate([TaxLineInput(1000, code)], exempt=True)
    assert res.tax_cents == 0 and res.exempt_cents == 1000
    # a sales-only rate is ignored on purchases
    assert calculate([TaxLineInput(1000, code)], direction="purchases").tax_cents == 0
    both = _code(("VAT", 20.0), applies="both")
    assert calculate([TaxLineInput(1000, both)], direction="purchases").tax_cents == 200


# ---------------------------------------------------------------- through the API


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return c


def _setup_local(client):
    state = client.post("/api/tax/agencies", json={"name": "State DOR", "filing_frequency": "quarterly"}).json
    city = client.post("/api/tax/agencies", json={"name": "City of Riverton", "filing_frequency": "monthly"}).json
    r1 = client.post("/api/tax/rates", json={"name": "State 6%", "agency_id": state["id"], "rate": 6}).json
    r2 = client.post("/api/tax/rates", json={"name": "City 2.25%", "agency_id": city["id"], "rate": 2.25}).json
    code = client.post("/api/tax/codes", json={"name": "Riverton", "rate_ids": [r1["id"], r2["id"]]}).json
    assert code["sales_rate"] == 8.25
    return state, city, code


def test_invoice_with_tax_code_posts_and_reports(client):
    state, city, code = _setup_local(client)
    cid = client.post("/api/customers", json={"name": "Acme", "default_tax_code_id": code["id"]}).json["id"]
    inv = client.post(
        "/api/invoices",
        json={
            "customer_id": cid,
            "date": "2026-02-10",
            "lines": [
                {"description": "Widgets", "quantity": 4, "unit_price": 25, "account_id": acct(client, "4000")["id"], "tax_code_id": code["id"]},
                {"description": "Labour (not taxable)", "quantity": 1, "unit_price": 50, "account_id": acct(client, "4100")["id"]},
            ],
        },
    )
    assert inv.status_code == 201, inv.json
    inv = inv.json
    assert inv["subtotal"] == 150 and inv["tax"] == 8.25 and inv["total"] == 158.25
    assert {d["name"]: d["tax"] for d in inv["tax_details"]} == {"State 6%": 6.0, "City 2.25%": 2.25}
    assert acct(client, "2200")["balance"] == 8.25
    assert acct(client, "4000")["balance"] == 100

    rep = client.get("/api/tax/liability?start=2026-01-01&end=2026-03-31").json
    by_agency = {a["agency"]: a for a in rep["agencies"]}
    assert by_agency["State DOR"]["tax_collected"] == 6 and by_agency["City of Riverton"]["tax_collected"] == 2.25
    assert rep["totals"]["taxable_sales"] == 100 and rep["totals"]["non_taxable_sales"] == 50

    # paying the state for Q1 clears its share of the liability
    pay = client.post(
        "/api/tax/payments",
        json={"agency_id": state["id"], "period_start": "2026-01-01", "period_end": "2026-03-31", "date": "2026-04-15", "amount": 6, "account_id": acct(client, "1010")["id"]},
    )
    assert pay.status_code == 201, pay.json
    assert acct(client, "2200")["balance"] == 2.25
    overview = {a["name"]: a for a in client.get("/api/tax/overview").json["agencies"]}
    assert overview["State DOR"]["balance"] == 0 and overview["City of Riverton"]["balance"] == 2.25
    assert client.get("/api/reports/balance-sheet").json["balanced"]


def test_inclusive_invoice_and_exempt_customer(client):
    _, _, code = _setup_local(client)
    cid = client.post("/api/customers", json={"name": "Shop"}).json["id"]
    line = {"description": "Gift", "quantity": 1, "unit_price": 108.25, "account_id": acct(client, "4000")["id"], "tax_code_id": code["id"]}
    inv = client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "amounts_inclusive": True, "lines": [line]}).json
    assert inv["total"] == 108.25 and inv["subtotal"] == 100 and inv["tax"] == 8.25
    assert acct(client, "4000")["balance"] == 100  # income booked net of tax

    exempt = client.post("/api/customers", json={"name": "Charity", "tax_exempt": True, "exemption_reason": "501(c)(3)"}).json["id"]
    inv2 = client.post("/api/invoices", json={"customer_id": exempt, "date": "2026-02-11", "lines": [{**line, "unit_price": 100}]}).json
    assert inv2["tax"] == 0
    rep = client.get("/api/tax/liability?start=2026-01-01&end=2026-03-31").json
    assert rep["totals"]["exempt_sales"] == 100


def test_void_removes_tax_and_editing_rate_keeps_history(client):
    _, _, code = _setup_local(client)
    cid = client.post("/api/customers", json={"name": "Acme"}).json["id"]
    line = {"description": "x", "quantity": 1, "unit_price": 100, "account_id": acct(client, "4000")["id"], "tax_code_id": code["id"]}
    inv = client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "lines": [line]}).json
    # changing the rate later does not alter the saved invoice
    rate_id = code["rate_ids"][0]
    client.put(f"/api/tax/rates/{rate_id}", json={"name": "State 7%", "agency_id": code["rates"][0]["agency_id"], "rate": 7})
    assert client.get(f"/api/invoices/{inv['id']}").json["tax"] == 8.25
    client.post(f"/api/invoices/{inv['id']}/void", json={})
    rep = client.get("/api/tax/liability?start=2026-01-01&end=2026-03-31").json
    assert rep["agencies"] == []
    assert acct(client, "2200")["balance"] == 0


def test_vat_input_tax_on_bills_reduces_liability(client):
    client.post("/api/tax/templates/uk_vat", json={})
    setup = client.get("/api/tax/setup").json
    std = next(c for c in setup["codes"] if c["name"] == "Standard 20%")
    cid = client.post("/api/customers", json={"name": "UK Client"}).json["id"]
    client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "lines": [{"description": "Consulting", "quantity": 1, "unit_price": 1000, "account_id": acct(client, "4100")["id"], "tax_code_id": std["id"]}]})
    vid = client.post("/api/vendors", json={"name": "Supplier"}).json["id"]
    bill = client.post("/api/bills", json={"vendor_id": vid, "date": "2026-02-12", "lines": [{"account_id": acct(client, "6400")["id"], "amount": 240, "tax_code_id": std["id"]}], "amounts_inclusive": True})
    assert bill.status_code == 201, bill.json
    assert bill.json["total"] == 240 and bill.json["tax"] == 40
    assert acct(client, "6400")["balance"] == 200  # expense booked net
    assert acct(client, "2200")["balance"] == 160  # 200 output VAT - 40 input VAT
    rep = client.get("/api/tax/liability?start=2026-01-01&end=2026-03-31").json
    hmrc = rep["agencies"][0]
    assert hmrc["tax_collected"] == 200 and hmrc["input_tax"] == 40 and hmrc["net"] == 160
    # expenses too
    exp = client.post("/api/expenses", json={"date": "2026-02-13", "payee": "Shop", "account_id": acct(client, "1010")["id"], "lines": [{"account_id": acct(client, "6400")["id"], "amount": 50, "tax_code_id": std["id"]}]})
    assert exp.json["total"] == 60 and exp.json["tax"] == 10
    assert client.get("/api/reports/trial-balance").json["total_debit"] == client.get("/api/reports/trial-balance").json["total_credit"]


def test_preview_matches_saved_document(client):
    _, _, code = _setup_local(client)
    cid = client.post("/api/customers", json={"name": "Acme"}).json["id"]
    lines = [{"quantity": 3, "unit_price": 19.99, "tax_code_id": code["id"]}, {"quantity": 1, "unit_price": 5}]
    prev = client.post("/api/tax/preview", json={"customer_id": cid, "lines": lines}).json
    saved = client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "lines": [{**l, "description": "x", "account_id": acct(client, "4000")["id"]} for l in lines]}).json
    assert prev["tax"] == saved["tax"] and prev["total"] == saved["total"]


def test_stripe_tax_provider(client, monkeypatch):
    from openbooks.api import online_payments

    class Calc(dict):
        pass

    class FakeCalcs:
        def __init__(self):
            self.params = None

        def create(self, params):
            self.params = params
            item = params["line_items"][0]
            tax = round(item["amount"] * 0.1025)
            return Calc(
                line_items={
                    "data": [
                        {
                            "reference": item["reference"],
                            "amount_tax": tax,
                            "tax_breakdown": [
                                {"amount": round(item["amount"] * 0.065), "taxable_amount": item["amount"], "jurisdiction": {"display_name": "Washington", "level": "state"}, "tax_rate_details": {"percentage_decimal": "6.5", "tax_type": "sales_tax"}},
                                {"amount": tax - round(item["amount"] * 0.065), "taxable_amount": item["amount"], "jurisdiction": {"display_name": "Seattle", "level": "city"}, "tax_rate_details": {"percentage_decimal": "3.75", "tax_type": "sales_tax"}},
                            ],
                        }
                    ]
                }
            )

    fake = NS(tax=NS(calculations=FakeCalcs()))
    monkeypatch.setattr(online_payments, "_client", lambda: fake)
    client.put("/api/stripe/config", json={"secret_key": "sk_test_abcdefghijklmnop"})
    assert client.put("/api/tax/settings", json={"tax_provider": "stripe_tax"}).status_code == 200
    cid = client.post("/api/customers", json={"name": "Seattle Co"}).json["id"]
    line = {"description": "Widget", "quantity": 1, "unit_price": 100, "account_id": acct(client, "4000")["id"]}
    # needs an address
    assert client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "lines": [line]}).status_code == 400
    client.put(f"/api/customers/{cid}", json={"name": "Seattle Co", "address_line1": "1 Pike St", "city": "Seattle", "region": "WA", "postal_code": "98101", "country": "us"})
    inv = client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-10", "lines": [line]})
    assert inv.status_code == 201, inv.json
    assert inv.json["tax"] == 10.25 and inv.json["tax_source"] == "stripe"
    assert fake.tax.calculations.params["customer_details"]["address"]["country"] == "US"
    agencies = {a["name"] for a in client.get("/api/tax/setup").json["agencies"]}
    assert {"Washington", "Seattle"} <= agencies  # agencies created from jurisdictions
    # preview does not call Stripe unless asked
    calls_before = fake.tax.calculations.params
    fake.tax.calculations.params = None
    assert client.post("/api/tax/preview", json={"customer_id": cid, "lines": [line]}).json["pending"] is True
    assert fake.tax.calculations.params is None
    fake.tax.calculations.params = calls_before


def test_legacy_flat_rate_invoices_are_migrated(tmp_path, monkeypatch):
    """A database from before the tax engine keeps its totals and gains tax history."""
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path)})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    cid = c.post("/api/customers", json={"name": "Old"}).json["id"]
    inv = c.post("/api/invoices", json={"customer_id": cid, "date": "2026-01-05", "tax_rate": 7.5, "lines": [{"description": "x", "quantity": 1, "unit_price": 200, "account_id": acct(c, "4000")["id"]}]}).json
    assert inv["tax"] == 15 and inv["tax_source"] == "legacy"
    # simulate an old install: drop the engine marker and the snapshot
    con = sqlite3.connect(tmp_path / "openbooks.db")
    con.execute("DELETE FROM setting WHERE key='tax_engine_version'")
    con.execute("DELETE FROM doc_tax")
    con.commit()
    con.close()
    app2 = create_app({"DATA_DIR": str(tmp_path)})
    c2 = app2.test_client()
    c2.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    migrated = c2.get(f"/api/invoices/{inv['id']}").json
    assert migrated["tax"] == 15 and migrated["lines"][0]["tax_code"] == "Sales tax 7.5%"
    rep = c2.get("/api/tax/liability?start=2026-01-01&end=2026-12-31").json
    assert rep["agencies"][0]["agency"] == "Sales tax" and rep["agencies"][0]["tax_collected"] == 15
    # re-saving the invoice through the engine gives the same tax
    again = c2.put(f"/api/invoices/{inv['id']}", json={"customer_id": cid, "date": "2026-01-05", "lines": [{"description": "x", "quantity": 1, "unit_price": 200, "account_id": acct(c2, "4000")["id"], "tax_code_id": migrated["lines"][0]["tax_code_id"]}]}).json
    assert again["tax"] == 15
