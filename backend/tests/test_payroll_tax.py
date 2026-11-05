import pytest

from openbooks import create_app
from openbooks.payroll_tax import BUILTIN_FEDERAL, RATES, federal_withholding, fica, state_withholding, unemployment
from tests.test_api import acct

T2026 = {"standard_deduction": BUILTIN_FEDERAL[2026]["standard_deduction"], "brackets": BUILTIN_FEDERAL[2026]["brackets"], "rates": RATES}


# ---------------------------------------------------------------- engine, checked by hand


def test_single_biweekly_standard():
    # 52,000 - 8,600 = 43,400; zero bracket 16,100 - 8,600 = 7,500 -> 35,900 taxable
    # 10% x 12,400 + 12% x 23,500 = 1,240 + 2,820 = 4,060 / 26 = 156.15
    assert federal_withholding(T2026, wages_cents=200000, periods=26) == 15615


def test_single_biweekly_multiple_jobs_checkbox():
    # no allowance; zero = 8,050; taxable 43,950; halved brackets 6,200 / 25,200 / 52,850
    # 620 + 2,280 + 4,125 = 7,025 / 26 = 270.19
    assert federal_withholding(T2026, wages_cents=200000, periods=26, multiple_jobs=True) == 27019


def test_married_monthly_with_dependents_and_extra():
    # 96,000 - 12,900 = 83,100; zero 19,300 -> 63,800; 2,480 + 4,680 = 7,160 - 4,000 = 3,160 / 12 = 263.33 + 25 extra
    assert federal_withholding(T2026, wages_cents=800000, periods=12, filing_status="married_jointly", dependents_cents=400000, extra_cents=2500) == 26333 + 2500


def test_low_wages_withhold_nothing_and_credit_never_negative():
    assert federal_withholding(T2026, wages_cents=20000, periods=52) == 0
    assert federal_withholding(T2026, wages_cents=200000, periods=26, dependents_cents=1000000) == 0


def test_fica_wage_base_and_additional_medicare():
    ss = BUILTIN_FEDERAL[2026]["social_security"]
    med = BUILTIN_FEDERAL[2026]["medicare"]
    f = fica(ss, med, wages_cents=200000, ytd_wages_cents=0)
    assert f["ss_employee"] == f["ss_employer"] == 12400 and f["medicare_employee"] == 2900 and f["addl_medicare"] == 0
    capped = fica(ss, med, wages_cents=100000, ytd_wages_cents=18400000)  # only 500 left under the 184,500 base
    assert capped["ss_employee"] == 3100
    over = fica(ss, med, wages_cents=100000, ytd_wages_cents=19950000)  # 500 over the 200,000 threshold
    assert over["addl_medicare"] == 450 and over["ss_employee"] == 0


def test_unemployment_wage_base():
    assert unemployment({"rate": 0.6, "wage_base": 7000}, wages_cents=100000, ytd_wages_cents=650000) == 300
    assert unemployment({"rate": 0.6, "wage_base": 7000}, wages_cents=100000, ytd_wages_cents=700000) == 0


def test_state_methods():
    assert state_withholding({"method": "none"}, wages_cents=200000, periods=26) == 0
    assert state_withholding({"method": "flat", "rate": 5}, wages_cents=200000, periods=26) == 10000
    brackets = {"method": "brackets", "rates": [2, 5], "brackets": {"single": [10000]}, "standard_deduction": {"single": 2000}}
    # 52,000 - 2,000 = 50,000: 2% x 10,000 + 5% x 40,000 = 2,200 / 26 = 84.62
    assert state_withholding(brackets, wages_cents=200000, periods=26) == 8462


# ---------------------------------------------------------------- through the API


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return c


def _tables(client, year=2026):
    return {(t["jurisdiction"], t["kind"]): t for t in client.get(f"/api/payroll-tax/tables?year={year}").json["tables"]}


def test_builtin_tables_present_and_unverified(client):
    tables = _tables(client)
    assert ("US-FED", "income_tax") in tables and ("US-TX", "income_tax") in tables
    assert not tables[("US-FED", "income_tax")]["verified"]


def test_payroll_from_tables_requires_verification_or_acknowledgement(client):
    emp = client.post(
        "/api/employees",
        json={"name": "Sam", "pay_type": "salary", "pay_rate": 52000, "pay_schedule": "biweekly", "withholding_method": "tables", "w4_filing_status": "single", "work_state": "TX"},
    ).json
    assert emp["withholding_method"] == "tables"
    period = {"period_start": "2026-03-02", "period_end": "2026-03-15", "pay_date": "2026-03-20", "employees": [{"employee_id": emp["id"]}]}
    prev = client.post("/api/payroll/preview", json=period).json
    check = prev["paychecks"][0]
    assert check["gross"] == 2000 and check["federal_withholding"] == 156.15
    assert check["social_security"] == 124 and check["medicare"] == 29 and check["state_withholding"] == 0
    assert check["futa"] == 12  # 0.6% of 2,000
    assert prev["unverified_tables"]

    run = dict(period, account_id=acct(client, "1010")["id"])
    blocked = client.post("/api/payroll/runs", json=run)
    assert blocked.status_code == 400 and "verified" in blocked.json["error"]
    ok = client.post("/api/payroll/runs", json={**run, "acknowledge_unverified": True})
    assert ok.status_code == 201, ok.json
    # employer: 124 SS + 29 Medicare + 12 FUTA = 165
    assert acct(client, "6810")["balance"] == 165
    owed = client.get("/api/payroll/liabilities").json["balance"]
    assert owed == round(156.15 + 124 * 2 + 29 * 2 + 12, 2)
    rep = client.get("/api/payroll-tax/liability?start=2026-01-01&end=2026-12-31").json
    names = {l["name"]: l["amount"] for l in rep["lines"]}
    assert names["Federal income tax withheld"] == 156.15 and names["Federal unemployment (FUTA)"] == 12
    assert rep["total"] == owed
    assert client.get("/api/reports/balance-sheet").json["balanced"]

    # once verified, no acknowledgement is needed
    for t in prev["tables_used"]:
        assert client.post(f"/api/payroll-tax/tables/{t['id']}/verify", json={}).json["verified"]
    second = client.post("/api/payroll/runs", json={**run, "period_start": "2026-03-16", "period_end": "2026-03-29", "pay_date": "2026-04-03"})
    assert second.status_code == 201, second.json


def test_editing_table_clears_verification_and_validates(client):
    fed = _tables(client)[("US-FED", "income_tax")]
    client.post(f"/api/payroll-tax/tables/{fed['id']}/verify", json={})
    bad = dict(fed["data"])
    bad["brackets"] = {**bad["brackets"], "single": [1, 2]}
    assert client.put(f"/api/payroll-tax/tables/{fed['id']}", json={"data": bad}).status_code == 400
    edited = client.put(f"/api/payroll-tax/tables/{fed['id']}", json={"data": fed["data"]}).json
    assert edited["verified"] is False


def test_state_table_and_suta(client):
    client.put("/api/tax/method", json={"method": "us_tables"})
    client.post("/api/payroll-tax/tables", json={"tax_year": 2026, "jurisdiction": "US-ZZ", "kind": "income_tax", "data": {"method": "flat", "rate": 4}})
    client.post("/api/payroll-tax/tables", json={"tax_year": 2026, "jurisdiction": "US-ZZ", "kind": "suta", "data": {"rate": 2.7, "wage_base": 9000}})
    emp = client.post("/api/employees", json={"name": "Z", "pay_type": "hourly", "pay_rate": 25, "pay_schedule": "weekly", "work_state": "ZZ"}).json
    prev = client.post("/api/payroll/preview", json={"period_start": "2026-01-05", "period_end": "2026-01-11", "pay_date": "2026-01-16", "employees": [{"employee_id": emp["id"], "hours": 40}]}).json
    check = prev["paychecks"][0]
    assert check["gross"] == 1000 and check["state_withholding"] == 40 and check["suta"] == 27
    # missing state table is a clear error
    emp2 = client.post("/api/employees", json={"name": "Q", "pay_type": "hourly", "pay_rate": 25, "pay_schedule": "weekly", "work_state": "QQ"}).json
    r = client.post("/api/payroll/preview", json={"period_start": "2026-01-05", "period_end": "2026-01-11", "pay_date": "2026-01-16", "employees": [{"employee_id": emp2["id"], "hours": 1}]})
    assert r.status_code == 400 and "QQ" in r.json["error"]


def test_copy_year(client):
    assert client.post("/api/payroll-tax/tables/copy-year", json={"from_year": 2026, "to_year": 2027}).json["created"] > 0
    t27 = _tables(client, 2027)
    assert t27[("US-FED", "income_tax")]["verified"] is False


def test_existing_percent_employees_unchanged(client):
    emp = client.post("/api/employees", json={"name": "Legacy", "pay_type": "hourly", "pay_rate": 20, "pay_schedule": "weekly", "withholding_method": "percent", "federal_withholding_pct": 10}).json
    prev = client.post("/api/payroll/preview", json={"period_start": "2026-01-05", "period_end": "2026-01-11", "pay_date": "2026-01-16", "employees": [{"employee_id": emp["id"], "hours": 10}]}).json
    assert prev["paychecks"][0]["federal_withholding"] == 20 and prev["unverified_tables"] == []


def test_tax_method_selector(client):
    m = client.get("/api/tax/method").json
    assert m["method"] == "manual" and m["payroll_default"] == "percent"
    assert m["payroll_tables"]["has_federal"]
    pct = client.post("/api/employees", json={"name": "A", "pay_type": "hourly", "pay_rate": 20, "pay_schedule": "weekly"}).json
    assert pct["withholding_method"] == "percent"

    r = client.put("/api/tax/method", json={"method": "us_tables", "apply_to_employees": True}).json
    assert r["method"] == "us_tables" and r["payroll_default"] == "tables" and r["employees_switched"] == 1
    assert client.post("/api/employees", json={"name": "B", "pay_type": "hourly", "pay_rate": 20, "pay_schedule": "weekly"}).json["withholding_method"] == "tables"
    assert client.get("/api/tax/setup").json["settings"]["tax_provider"] == "manual"

    # third-party needs Stripe connected
    assert client.put("/api/tax/method", json={"method": "stripe_tax"}).status_code == 400
    client.put("/api/stripe/config", json={"secret_key": "sk_test_abcdefghijklmnop"})
    r = client.put("/api/tax/method", json={"method": "stripe_tax", "payroll_default": "tables", "stripe_default_tax_code": "txcd_10000000"}).json
    assert r["method"] == "stripe_tax" and r["payroll_default"] == "tables" and r["stripe_default_tax_code"] == "txcd_10000000"
    assert client.get("/api/tax/setup").json["settings"]["tax_provider"] == "stripe_tax"
    assert client.put("/api/tax/method", json={"method": "stripe_tax", "stripe_default_tax_code": "bad"}).status_code == 400
    assert client.put("/api/tax/method", json={"method": "nonsense"}).status_code == 400
