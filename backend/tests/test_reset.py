import pytest

from openbooks import create_app
from tests.test_api import acct


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return c


def _counts(c):
    return {
        "customers": len(c.get("/api/customers?include_inactive=1").json),
        "invoices": len(c.get("/api/invoices?kind=all").json),
        "journal": len(c.get("/api/journal-entries").json),
        "items": len(c.get("/api/items?include_inactive=1").json),
        "employees": len(c.get("/api/employees?include_inactive=1").json),
        "agencies": len(c.get("/api/tax/setup").json["agencies"]),
    }


def test_remove_sample_data_restores_empty_books(client):
    # a tax agency the user created before loading sample data is kept
    client.post("/api/tax/agencies", json={"name": "My own agency"})
    assert client.post("/api/settings/sample-data", json={}).status_code == 200
    s = client.get("/api/settings").json
    assert s["sample_data_loaded"] and not s["books_empty"]
    assert _counts(client)["invoices"] > 0

    assert client.post("/api/settings/sample-data/remove", json={}).status_code == 200
    counts = _counts(client)
    assert counts == {"customers": 0, "invoices": 0, "journal": 0, "items": 0, "employees": 0, "agencies": 1}
    s = client.get("/api/settings").json
    assert s["books_empty"] and not s["sample_data_loaded"]
    assert s["next_invoice_number"] == "1001" and s["default_sales_tax_code_id"] == ""
    assert all(a["balance"] == 0 for a in client.get("/api/accounts").json)
    assert client.get("/api/reports/balance-sheet").json["balanced"]
    # can load again afterwards
    assert client.post("/api/settings/sample-data", json={}).status_code == 200


def test_remove_refuses_when_real_data_was_added(client):
    client.post("/api/settings/sample-data", json={})
    cid = client.post("/api/customers", json={"name": "Real customer"}).json["id"]
    client.post("/api/invoices", json={"customer_id": cid, "date": "2026-01-02", "lines": [{"description": "x", "quantity": 1, "unit_price": 10, "account_id": acct(client, "4000")["id"]}]})
    r = client.post("/api/settings/sample-data/remove", json={})
    assert r.status_code == 409 and "Erase all data" in r.json["error"]
    assert _counts(client)["invoices"] > 1  # nothing deleted


def test_erase_all_data(client):
    client.post("/api/settings/sample-data", json={})
    assert client.post("/api/settings/erase", json={"confirm": "erase"}).status_code == 400
    assert client.post("/api/settings/erase", json={"confirm": "ERASE"}).status_code == 200
    counts = _counts(client)
    assert counts["invoices"] == counts["journal"] == counts["customers"] == counts["employees"] == 0
    assert counts["agencies"] > 0  # tax setup kept by default
    client.post("/api/settings/erase", json={"confirm": "ERASE", "include_tax_setup": True})
    assert _counts(client)["agencies"] == 0
    assert client.get("/api/settings").json["books_empty"]
    # users, accounts and payroll tables survive
    assert client.get("/api/users").json and client.get("/api/accounts").json
    assert client.get("/api/payroll-tax/tables").json["tables"]


def test_only_admins(client):
    client.post("/api/users", json={"email": "acc@x.com", "name": "A", "password": "password123", "role": "accountant"})
    client.post("/api/auth/logout", json={})
    client.post("/api/auth/login", json={"email": "acc@x.com", "password": "password123"})
    assert client.post("/api/settings/erase", json={"confirm": "ERASE"}).status_code == 403
    assert client.post("/api/settings/sample-data/remove", json={}).status_code == 403
