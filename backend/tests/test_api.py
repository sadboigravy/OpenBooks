from datetime import date, timedelta

import pytest

from openbooks import create_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    return create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})


@pytest.fixture
def client(app):
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    assert r.status_code == 200, r.json
    return c


def acct(client, code):
    return next(a for a in client.get("/api/accounts").json if a["code"] == code)


def test_requires_login(app):
    c = app.test_client()
    assert c.get("/api/accounts").status_code == 401
    assert c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "nope"}).status_code == 401


def test_rejects_non_json_posts(client):
    r = client.post("/api/customers", data={"name": "x"})
    assert r.status_code == 415


def test_unbalanced_journal_entry_rejected(client):
    cash, equity = acct(client, "1010"), acct(client, "3000")
    r = client.post(
        "/api/journal-entries",
        json={"date": "2026-01-01", "lines": [{"account_id": cash["id"], "debit": "100"}, {"account_id": equity["id"], "credit": "99"}]},
    )
    assert r.status_code == 400
    assert "must equal" in r.json["error"]


def test_invoice_payment_flow_and_reports(client):
    customer = client.post("/api/customers", json={"name": "Acme"}).json
    sales, checking = acct(client, "4100"), acct(client, "1010")
    today = date.today().isoformat()

    inv = client.post(
        "/api/invoices",
        json={
            "customer_id": customer["id"],
            "date": today,
            "tax_rate": 10,
            "lines": [
                {"description": "Work", "quantity": 2, "unit_price": "50.00", "account_id": sales["id"]},
                {"description": "Non taxable", "quantity": 1, "unit_price": "10", "account_id": sales["id"], "taxable": False},
            ],
        },
    )
    assert inv.status_code == 201, inv.json
    inv = inv.json
    assert inv["subtotal"] == 110 and inv["tax"] == 10 and inv["total"] == 120
    assert inv["status"] == "open"
    assert acct(client, "1200")["balance"] == 120
    assert acct(client, "2200")["balance"] == 10

    # overpayment rejected
    r = client.post(f"/api/invoices/{inv['id']}/payments", json={"date": today, "amount": 500, "account_id": checking["id"]})
    assert r.status_code == 400

    r = client.post(f"/api/invoices/{inv['id']}/payments", json={"date": today, "amount": 20, "account_id": checking["id"]})
    assert r.status_code == 201 and r.json["status"] == "partial" and r.json["balance"] == 100
    r = client.post(f"/api/invoices/{inv['id']}/payments", json={"date": today, "amount": 100, "account_id": checking["id"]})
    assert r.json["status"] == "paid"
    assert acct(client, "1200")["balance"] == 0
    assert acct(client, "1010")["balance"] == 120

    pl = client.get("/api/reports/profit-loss").json
    assert pl["net_income"] == 110
    bs = client.get("/api/reports/balance-sheet").json
    assert bs["balanced"] and bs["total_assets"] == 120
    tb = client.get("/api/reports/trial-balance").json
    assert tb["total_debit"] == tb["total_credit"]


def test_edit_invoice_reposts_entry(client):
    customer = client.post("/api/customers", json={"name": "Acme"}).json
    sales = acct(client, "4000")
    payload = {"customer_id": customer["id"], "date": "2026-01-10", "lines": [{"description": "A", "quantity": 1, "unit_price": 100, "account_id": sales["id"]}]}
    inv = client.post("/api/invoices", json=payload).json
    payload["lines"][0]["unit_price"] = 250
    r = client.put(f"/api/invoices/{inv['id']}", json=payload)
    assert r.json["total"] == 250
    assert acct(client, "1200")["balance"] == 250
    assert len(client.get("/api/journal-entries").json) == 1

    assert client.post(f"/api/invoices/{inv['id']}/void", json={}).json["status"] == "void"
    assert acct(client, "1200")["balance"] == 0


def test_draft_invoice_not_posted(client):
    customer = client.post("/api/customers", json={"name": "Acme"}).json
    sales = acct(client, "4000")
    r = client.post(
        "/api/invoices",
        json={"customer_id": customer["id"], "status": "draft", "date": "2026-01-10", "lines": [{"description": "A", "unit_price": 100, "quantity": 1, "account_id": sales["id"]}]},
    )
    assert r.json["status"] == "draft"
    assert acct(client, "1200")["balance"] == 0


def test_bill_and_expense(client):
    vendor = client.post("/api/vendors", json={"name": "Landlord"}).json
    rent, checking, card = acct(client, "6600"), acct(client, "1010"), acct(client, "2100")
    bill = client.post(
        "/api/bills",
        json={"vendor_id": vendor["id"], "date": "2026-01-01", "due_date": "2026-01-15", "lines": [{"account_id": rent["id"], "amount": "1500"}]},
    ).json
    assert acct(client, "2000")["balance"] == 1500
    r = client.post(f"/api/bills/{bill['id']}/payments", json={"date": "2026-01-10", "amount": 1500, "account_id": checking["id"]})
    assert r.json["status"] == "paid"
    assert acct(client, "2000")["balance"] == 0

    supplies = acct(client, "6400")
    r = client.post(
        "/api/expenses",
        json={"date": "2026-01-05", "payee": "Office Depot", "account_id": card["id"], "lines": [{"account_id": supplies["id"], "amount": 42.5}]},
    )
    assert r.status_code == 201, r.json
    assert acct(client, "2100")["balance"] == 42.5
    assert acct(client, "1010")["balance"] == -1500


def test_bank_import_and_categorize(client):
    checking, fees = acct(client, "1010"), acct(client, "6100")
    csv_text = "Date,Description,Amount\n2026-01-03,Monthly fee,-15.00\n01/04/2026,Deposit,200\n"
    r = client.post("/api/bank/import", json={"account_id": checking["id"], "csv": csv_text})
    assert r.json["imported"] == 2
    r = client.post("/api/bank/import", json={"account_id": checking["id"], "csv": csv_text})
    assert r.json["imported"] == 0 and r.json["skipped_duplicates"] == 2

    txs = client.get(f"/api/bank/transactions?account_id={checking['id']}&status=review").json
    fee = next(t for t in txs if t["amount"] == -15)
    r = client.post(f"/api/bank/transactions/{fee['id']}/categorize", json={"account_id": fees["id"]})
    assert r.json["status"] == "categorized"
    assert acct(client, "6100")["balance"] == 15
    assert acct(client, "1010")["balance"] == -15

    client.post(f"/api/bank/transactions/{fee['id']}/undo", json={})
    assert acct(client, "6100")["balance"] == 0


def test_viewer_is_read_only(client):
    client.post("/api/users", json={"email": "v@x.com", "name": "V", "password": "password123", "role": "viewer"})
    client.post("/api/auth/logout", json={})
    client.post("/api/auth/login", json={"email": "v@x.com", "password": "password123"})
    assert client.get("/api/accounts").status_code == 200
    assert client.post("/api/customers", json={"name": "x"}).status_code == 403
    assert client.get("/api/users").status_code == 403
    # calculation-only endpoints don't save anything, so viewers may use them
    assert client.post("/api/tax/preview", json={"lines": []}).status_code != 403
    assert client.post("/api/payroll/preview", json={"employees": []}).status_code != 403


def test_demo_data_loads_and_books_balance(client):
    assert client.post("/api/settings/sample-data", json={}).status_code == 200
    bs = client.get("/api/reports/balance-sheet").json
    assert bs["balanced"], bs
    tb = client.get("/api/reports/trial-balance").json
    assert tb["total_debit"] == tb["total_credit"]
    dash = client.get("/api/dashboard").json
    assert dash["cash"] > 0 and len(dash["series"]) == 12
    assert client.get("/api/reports/ar-aging").json["totals"]["total"] > 0
    assert client.get("/api/reports/general-ledger").json["accounts"]
    # can't load twice
    assert client.post("/api/settings/sample-data", json={}).status_code == 400


def test_spa_fallback(app, tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<div id=root></div>")
    c = app.test_client()
    assert c.get("/invoices/5").status_code == 200
    assert b"root" in c.get("/reports/profit-loss").data
    assert c.get("/api/does-not-exist").status_code in (401, 404)
