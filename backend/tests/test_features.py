import sqlite3
from datetime import date, timedelta

import pytest

from openbooks import create_app
from tests.test_api import acct  # noqa: F401  (shared helper)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return c


def bal(client, code):
    return acct(client, code)["balance"]


def customer(client, name="Acme"):
    return client.post("/api/customers", json={"name": name}).json["id"]


def test_items_fill_invoice_lines(client):
    item = client.post("/api/items", json={"name": "Widget", "price": "25", "income_account_id": acct(client, "4000")["id"]}).json
    assert item["price"] == 25
    inv = client.post(
        "/api/invoices",
        json={"customer_id": customer(client), "date": "2026-02-01", "lines": [{"item_id": item["id"], "quantity": 4, "unit_price": 25}]},
    )
    assert inv.status_code == 201, inv.json
    assert inv.json["lines"][0]["item"] == "Widget"
    assert bal(client, "4000") == 100
    # in use -> cannot delete
    assert client.delete(f"/api/items/{item['id']}").status_code == 400


def test_estimate_does_not_post_and_converts(client):
    cid = customer(client)
    sales = acct(client, "4100")["id"]
    est = client.post(
        "/api/invoices",
        json={"kind": "estimate", "customer_id": cid, "date": "2026-02-01", "lines": [{"description": "Job", "quantity": 1, "unit_price": 500, "account_id": sales}]},
    ).json
    assert est["number"].startswith("EST-") and est["status"] in ("pending", "expired")
    assert bal(client, "1200") == 0
    assert client.post(f"/api/invoices/{est['id']}/status", json={"status": "accepted"}).json["status"] == "accepted"

    inv = client.post(
        "/api/invoices",
        json={"customer_id": cid, "date": "2026-02-05", "estimate_id": est["id"], "lines": [{"description": "Job", "quantity": 1, "unit_price": 500, "account_id": sales}]},
    ).json
    assert inv["estimate_id"] == est["id"]
    assert client.get(f"/api/invoices/{est['id']}").json["status"] == "closed"
    assert bal(client, "1200") == 500


def test_sales_receipt_posts_to_bank(client):
    r = client.post(
        "/api/invoices",
        json={
            "kind": "sales_receipt",
            "customer_id": customer(client),
            "date": "2026-02-01",
            "deposit_account_id": acct(client, "1010")["id"],
            "tax_rate": 5,
            "lines": [{"description": "Walk-in sale", "quantity": 2, "unit_price": 50, "account_id": acct(client, "4000")["id"]}],
        },
    )
    assert r.status_code == 201, r.json
    assert r.json["status"] == "paid" and r.json["number"].startswith("SR-")
    assert bal(client, "1010") == 105
    assert bal(client, "1200") == 0
    assert bal(client, "2200") == 5


def test_receive_payment_across_invoices(client):
    cid = customer(client)
    sales = acct(client, "4100")["id"]
    ids = [
        client.post("/api/invoices", json={"customer_id": cid, "date": "2026-02-01", "lines": [{"description": "x", "quantity": 1, "unit_price": amt, "account_id": sales}]}).json["id"]
        for amt in (100, 200)
    ]
    r = client.post(
        "/api/payments/receive",
        json={"customer_id": cid, "date": date.today().isoformat(), "account_id": acct(client, "1010")["id"], "applications": [{"invoice_id": ids[0], "amount": 100}, {"invoice_id": ids[1], "amount": 50}]},
    )
    assert r.status_code == 201, r.json
    assert r.json["total"] == 150
    assert bal(client, "1200") == 150
    summary = client.get("/api/sales/summary").json
    assert summary["paid"]["total"] == 150
    types = {t["type"] for t in client.get(f"/api/sales/transactions?customer_id={cid}").json}
    assert types == {"invoice", "payment"}


def test_pay_multiple_bills(client):
    vid = client.post("/api/vendors", json={"name": "Supplier"}).json["id"]
    rent = acct(client, "6600")["id"]
    bills = [
        client.post("/api/bills", json={"vendor_id": vid, "date": "2026-02-01", "lines": [{"account_id": rent, "amount": amt}]}).json["id"]
        for amt in (300, 400)
    ]
    r = client.post(
        "/api/bills/pay",
        json={"date": "2026-02-15", "account_id": acct(client, "1010")["id"], "applications": [{"bill_id": b, "amount": a} for b, a in zip(bills, (300, 400))]},
    )
    assert r.status_code == 201, r.json
    assert bal(client, "2000") == 0
    assert bal(client, "1010") == -700
    assert len(client.get(f"/api/purchases/transactions?vendor_id={vid}").json) == 4


def test_deposit_and_transfer(client):
    checking, savings, other = acct(client, "1010")["id"], acct(client, "1020")["id"], acct(client, "4900")["id"]
    dep = client.post("/api/deposits", json={"date": "2026-02-01", "account_id": checking, "lines": [{"account_id": other, "amount": 250}, {"account_id": other, "amount": 50}]})
    assert dep.status_code == 201, dep.json
    assert dep.json["total"] == 300
    assert bal(client, "1010") == 300
    tr = client.post("/api/transfers", json={"date": "2026-02-02", "from_account_id": checking, "to_account_id": savings, "amount": 120})
    assert tr.status_code == 201
    assert bal(client, "1010") == 180 and bal(client, "1020") == 120
    # edit the transfer
    client.put(f"/api/transfers/{tr.json['id']}", json={"date": "2026-02-02", "from_account_id": checking, "to_account_id": savings, "amount": 100})
    assert bal(client, "1020") == 100
    assert client.delete(f"/api/journal-entries/{tr.json['id']}").status_code == 200
    assert bal(client, "1020") == 0


def test_reconcile_flow(client):
    checking, equity, fees = acct(client, "1010")["id"], acct(client, "3000")["id"], acct(client, "6100")["id"]
    client.post("/api/journal-entries", json={"date": "2026-01-02", "lines": [{"account_id": checking, "debit": 1000}, {"account_id": equity, "credit": 1000}]})
    client.post("/api/journal-entries", json={"date": "2026-01-20", "lines": [{"account_id": fees, "debit": 15}, {"account_id": checking, "credit": 15}]})
    late = client.post("/api/journal-entries", json={"date": "2026-02-05", "lines": [{"account_id": fees, "debit": 5}, {"account_id": checking, "credit": 5}]}).json

    ws = client.get(f"/api/reconcile/{checking}?statement_date=2026-01-31").json
    assert ws["beginning_balance"] == 0
    assert len(ws["lines"]) == 2  # Feb entry excluded
    ids = [l["id"] for l in ws["lines"]]

    bad = client.post(f"/api/reconcile/{checking}", json={"statement_date": "2026-01-31", "ending_balance": 990, "line_ids": ids})
    assert bad.status_code == 400 and "difference" in bad.json["error"]
    ok = client.post(f"/api/reconcile/{checking}", json={"statement_date": "2026-01-31", "ending_balance": 985, "line_ids": ids})
    assert ok.status_code == 201, ok.json

    ws2 = client.get(f"/api/reconcile/{checking}").json
    assert ws2["beginning_balance"] == 985 and len(ws2["lines"]) == 1
    # reconciled entries are locked
    first = client.get("/api/journal-entries").json[-1]
    assert client.delete(f"/api/journal-entries/{first['id']}").status_code == 400
    # undo unlocks
    assert client.post(f"/api/reconcile/history/{ok.json['id']}/undo", json={}).status_code == 200
    assert client.delete(f"/api/journal-entries/{late['id']}").status_code == 200


def test_timesheet_billable_time_and_payroll(client):
    cid = customer(client)
    item = client.post("/api/items", json={"name": "Labour", "price": 80, "income_account_id": acct(client, "4100")["id"]}).json
    emp = client.post(
        "/api/employees",
        json={"name": "Jo", "pay_type": "hourly", "pay_rate": "20", "pay_schedule": "weekly", "federal_withholding_pct": 10, "state_withholding_pct": 5},
    ).json
    monday = date(2026, 3, 2)
    r = client.put(
        "/api/time/week",
        json={
            "employee_id": emp["id"],
            "week_start": monday.isoformat(),
            "rows": [
                {"customer_id": cid, "item_id": item["id"], "billable": True, "description": "Install", "hours": [8, 8, 0, 0, 0, 0, 0]},
                {"description": "Admin", "hours": [0, 0, 4, 4, 0, 0, 0]},
            ],
        },
    )
    assert r.status_code == 200, r.json
    assert sum(t["hours"] for t in r.json) == 24

    unbilled = client.get(f"/api/time?customer_id={cid}&unbilled=1").json
    assert sum(t["hours"] for t in unbilled) == 16
    inv = client.post(
        "/api/invoices",
        json={"customer_id": cid, "date": "2026-03-09", "lines": [{"item_id": item["id"], "description": "Install", "quantity": 16, "unit_price": 80, "time_entry_ids": [t["id"] for t in unbilled]}]},
    ).json
    assert inv["total"] == 1280
    assert client.get(f"/api/time?customer_id={cid}&unbilled=1").json == []

    period = {"period_start": monday.isoformat(), "period_end": (monday + timedelta(days=6)).isoformat(), "pay_date": "2026-03-10"}
    prefill = client.get(f"/api/payroll/prefill?period_start={period['period_start']}&period_end={period['period_end']}").json
    assert prefill[0]["tracked_hours"] == 24
    preview = client.post("/api/payroll/preview", json={**period, "employees": [{"employee_id": emp["id"]}]}).json
    check = preview["paychecks"][0]
    assert check["gross"] == 480
    assert check["social_security"] == 29.76 and check["medicare"] == 6.96
    assert check["federal_withholding"] == 48 and check["state_withholding"] == 24
    assert check["net"] == round(480 - 29.76 - 6.96 - 48 - 24, 2)

    run = client.post("/api/payroll/runs", json={**period, "account_id": acct(client, "1010")["id"], "employees": [{"employee_id": emp["id"]}]})
    assert run.status_code == 201, run.json
    assert bal(client, "6800") == 480
    assert bal(client, "6810") == round(29.76 + 6.96, 2)
    assert bal(client, "1010") == -check["net"]
    owed = client.get("/api/payroll/liabilities").json["balance"]
    assert owed == round(29.76 * 2 + 6.96 * 2 + 48 + 24, 2)
    # time is now locked
    locked = client.get(f"/api/time?employee_id={emp['id']}").json
    assert all(t["locked"] for t in locked)

    assert client.post("/api/payroll/liabilities/pay", json={"date": "2026-03-15", "account_id": acct(client, "1010")["id"], "amount": owed}).status_code == 201
    assert client.get("/api/payroll/liabilities").json["balance"] == 0
    assert client.get("/api/reports/balance-sheet").json["balanced"]

    # deleting the run unlocks time
    assert client.delete(f"/api/payroll/runs/{run.json['id']}").status_code == 200
    assert bal(client, "6800") == 0


def test_salary_paycheck(client):
    emp = client.post("/api/employees", json={"name": "Sal", "pay_type": "salary", "pay_rate": "52000", "pay_schedule": "biweekly"}).json
    preview = client.post("/api/payroll/preview", json={"period_start": "2026-03-01", "period_end": "2026-03-14", "pay_date": "2026-03-15", "employees": [{"employee_id": emp["id"]}]}).json
    assert preview["paychecks"][0]["gross"] == 2000


def test_search(client):
    customer(client, "Zebra Corp")
    hits = client.get("/api/search?q=zeb").json
    assert hits and hits[0]["title"] == "Zebra Corp" and hits[0]["link"].startswith("/customers/")


def test_upgrades_old_database(tmp_path, monkeypatch):
    """A database from the previous version gains the new columns and accounts."""
    monkeypatch.delenv("DEMO_DATA", raising=False)
    create_app({"DATA_DIR": str(tmp_path)})
    db_path = tmp_path / "openbooks.db"
    con = sqlite3.connect(db_path)
    # simulate the old schema: drop a new column and the payroll accounts
    con.execute("DROP INDEX ix_invoice_kind")
    con.execute("ALTER TABLE invoice DROP COLUMN kind")
    con.execute("ALTER TABLE invoice DROP COLUMN method")
    con.execute("DELETE FROM account WHERE subtype IN ('payroll_tax_expense')")
    con.commit()
    con.close()

    app = create_app({"DATA_DIR": str(tmp_path)})
    con = sqlite3.connect(db_path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(invoice)")}
    assert {"kind", "method"} <= cols
    assert con.execute("SELECT kind FROM invoice").fetchall() == []
    assert con.execute("SELECT count(*) FROM account WHERE subtype='payroll_tax_expense'").fetchone()[0] == 1
    con.close()
    assert app.test_client().get("/health").status_code == 200


def test_suggested_number_skips_numbers_already_used(client):
    cid = customer(client)
    sales = acct(client, "4000")["id"]
    suggested = client.get("/api/invoices/next-number").json["number"]
    # save using the suggested number explicitly, as the form does
    client.post("/api/invoices", json={"customer_id": cid, "number": suggested, "date": "2026-01-01", "lines": [{"description": "x", "quantity": 1, "unit_price": 10, "account_id": sales}]})
    assert client.get("/api/invoices/next-number").json["number"] != suggested
