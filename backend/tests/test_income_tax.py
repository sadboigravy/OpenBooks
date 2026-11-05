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


def _books(client):
    cid = client.post("/api/customers", json={"name": "Acme"}).json["id"]
    client.post("/api/invoices", json={"customer_id": cid, "date": "2026-03-01", "lines": [{"description": "Work", "quantity": 1, "unit_price": 10000, "account_id": acct(client, "4100")["id"]}]})
    for code, amount in (("6000", 500), ("6300", 200), ("6600", 1800), ("6950", 300)):
        client.post("/api/expenses", json={"date": "2026-04-01", "payee": "X", "account_id": acct(client, "1010")["id"], "lines": [{"account_id": acct(client, code)["id"], "amount": amount}]})
    # an expense in the previous year must not count
    client.post("/api/expenses", json={"date": "2025-12-31", "payee": "X", "account_id": acct(client, "1010")["id"], "lines": [{"account_id": acct(client, "6000")["id"], "amount": 999}]})


def test_requires_a_form(client):
    assert client.get("/api/income-tax/summary").status_code == 400


def test_schedule_c_auto_map_and_summary(client):
    _books(client)
    setup = client.put("/api/income-tax/setup", json={"form": "schedule_c"}).json
    suggested = {a["code"]: a["suggested"] for a in setup["accounts"]}
    assert suggested["4100"] == "1" and suggested["6000"] == "8" and suggested["6300"] == "24b" and suggested["6600"] == "20b"
    assert suggested["6800"] == "26" and suggested["6810"] == "23"

    before = client.get("/api/income-tax/summary?year=2026").json
    assert len(before["unmapped"]) == 5 and "not mapped" in before["notes"][0]

    assert client.post("/api/income-tax/auto-map", json={}).json["mapped"] > 0
    s = client.get("/api/income-tax/summary?year=2026").json
    lines = {l["code"]: l for l in s["lines"]}
    assert lines["1"]["amount"] == 10000
    assert lines["8"]["amount"] == 500  # 2025 expense excluded
    assert lines["24b"]["amount"] == 200 and any("50%" in n for n in s["notes"])
    assert lines["27a"]["amount"] == 300  # software -> other expenses
    assert s["unmapped"] == []
    assert s["totals"]["net_profit"] == 10000 - 500 - 200 - 1800 - 300
    # net profit agrees with the P&L
    pl = client.get("/api/reports/profit-loss?start=2026-01-01&end=2026-12-31").json
    assert s["totals"]["net_profit"] == pl["net_income"]


def test_manual_mapping_and_validation(client):
    _books(client)
    client.put("/api/income-tax/setup", json={"form": "f1120"})
    soft = acct(client, "6950")["id"]
    assert client.put("/api/income-tax/mappings", json={"mappings": {str(soft): "999"}}).status_code == 400
    assert client.put("/api/income-tax/mappings", json={"mappings": {str(acct(client, '1010')['id']): "26"}}).status_code == 400
    r = client.put("/api/income-tax/mappings", json={"mappings": {str(soft): "22"}}).json
    assert next(a for a in r["accounts"] if a["id"] == soft)["line"] == "22"
    # mappings are kept per form
    client.put("/api/income-tax/setup", json={"form": "schedule_c"})
    assert next(a for a in client.get("/api/income-tax/setup").json["accounts"] if a["id"] == soft)["line"] is None


def test_custom_categories(client):
    _books(client)
    client.put("/api/income-tax/setup", json={"form": "custom", "custom_lines": [{"code": "T1", "label": "Turnover", "kind": "income"}, {"code": "E1", "label": "Allowable expenses", "kind": "expense"}]})
    mappings = {str(a["id"]): ("T1" if a["type"] == "income" else "E1") for a in client.get("/api/income-tax/setup").json["accounts"]}
    client.put("/api/income-tax/mappings", json={"mappings": mappings})
    s = client.get("/api/income-tax/summary?year=2026").json
    assert {l["code"]: l["amount"] for l in s["lines"]} == {"T1": 10000, "E1": 2800}


def test_fiscal_year(client):
    _books(client)
    client.put("/api/settings", json={"fiscal_year_start_month": "4"})
    client.put("/api/income-tax/setup", json={"form": "schedule_c"})
    client.post("/api/income-tax/auto-map", json={})
    s = client.get("/api/income-tax/summary?year=2026").json
    assert s["start"] == "2026-04-01" and s["end"] == "2027-03-31"
    assert {l["code"]: l["amount"] for l in s["lines"]}["1"] == 0  # March invoice is in the prior fiscal year
