import base64
from datetime import date, datetime, timedelta, timezone

import pytest

from openbooks import bank_feeds, create_app
from openbooks.models import BankConnection, Setting, db
from tests.test_api import acct


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    for env in bank_feeds.ENV.values():
        monkeypatch.delenv(env, raising=False)
    return create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return c


class FakeHttp:
    """Routes provider calls to canned responses and records what was sent."""

    def __init__(self):
        self.calls = []
        self.routes = {}

    def on(self, method, url_part, response, status=200):
        self.routes[(method, url_part)] = (status, response)

    def __call__(self, method, url, json_body=None, headers=None, form=None):
        self.calls.append((method, url, json_body, headers))
        for (m, part), (status, resp) in self.routes.items():
            if m == method and part in url:
                return status, resp(url, json_body) if callable(resp) else resp
        raise AssertionError(f"unexpected call {method} {url}")


@pytest.fixture
def http(monkeypatch):
    fake = FakeHttp()
    monkeypatch.setattr(bank_feeds, "_http", fake)
    return fake


def _epoch(d):
    return int(datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc).timestamp()) + 3600


def test_simplefin_connect_map_and_sync(client, http):
    today = date.today()
    token = base64.b64encode(b"https://bridge.example/simplefin/claim/abc").decode()
    http.on("POST", "/claim/abc", "https://user:pa55@bridge.example/simplefin")
    txs = [
        {"id": "t1", "posted": _epoch(today - timedelta(days=2)), "amount": "-42.50", "payee": "Coffee Co", "description": "POS 123"},
        {"id": "t2", "posted": _epoch(today - timedelta(days=1)), "amount": "1200.00", "description": "Client payment"},
        {"id": "t3", "posted": 0, "transacted_at": _epoch(today), "amount": "-5.00", "description": "Pending", "pending": True},
        {"id": "old", "posted": _epoch(today - timedelta(days=90)), "amount": "-9.99", "description": "Too old"},
    ]
    http.on(
        "GET",
        "/simplefin/accounts",
        lambda url, _: {
            "errors": [],
            "accounts": [{"id": "acc1", "name": "Business Checking", "currency": "USD", "balance": "5000.25", "org": {"name": "First Bank"}, "transactions": [] if "balances-only" in url else txs}],
        },
    )
    r = client.post("/api/bank-feeds/connections", json={"provider": "simplefin", "setup_token": token})
    assert r.status_code == 201, r.json
    conn = r.json
    assert conn["institution"] == "First Bank" and conn["accounts"][0]["name"] == "Business Checking"
    assert conn["accounts"][0]["balance"] == 5000.25
    assert "secret" not in conn and "pa55" not in r.get_data(as_text=True)
    # access URL is stored encrypted
    with client.application.app_context():
        assert "pa55" not in db.session.get(BankConnection, conn["id"]).secret

    checking = acct(client, "1010")["id"]
    la_id = conn["accounts"][0]["id"]
    r = client.put(f"/api/bank-feeds/accounts/{la_id}", json={"account_id": checking, "sync_from": (today - timedelta(days=30)).isoformat()})
    assert r.status_code == 200 and r.json["account_id"] == checking

    r = client.post(f"/api/bank-feeds/connections/{conn['id']}/sync", json={})
    assert r.status_code == 200, r.json
    assert r.json["imported"] == 2
    review = client.get(f"/api/bank/transactions?account_id={checking}&status=review").json
    by_desc = {t["description"]: t for t in review}
    assert by_desc["Coffee Co – POS 123"]["amount"] == -42.5
    assert by_desc["Client payment"]["amount"] == 1200.0
    assert all(t["source"] == "bank feed" for t in review)

    # syncing again imports nothing new
    assert client.post(f"/api/bank-feeds/connections/{conn['id']}/sync", json={}).json["imported"] == 0
    assert len(client.get(f"/api/bank/transactions?account_id={checking}&status=review").json) == 2


def test_simplefin_bad_token(client, http):
    r = client.post("/api/bank-feeds/connections", json={"provider": "simplefin", "setup_token": "not-a-token"})
    assert r.status_code == 400
    token = base64.b64encode(b"https://bridge.example/claim/used").decode()
    http.on("POST", "/claim/used", "Forbidden", status=403)
    r = client.post("/api/bank-feeds/connections", json={"provider": "simplefin", "setup_token": token})
    assert r.status_code == 400 and "only once" in r.json["error"]


def test_plaid_config_link_and_sync(client, http):
    # not configured yet
    r = client.post("/api/bank-feeds/plaid/link-token", json={})
    assert r.status_code == 400 and "Plaid client ID" in r.json["error"]

    r = client.put("/api/bank-feeds/config", json={"plaid_client_id": "cid", "plaid_secret": "plaid-secret-value", "plaid_env": "sandbox", "plaid_countries": "us, ca, gb"})
    assert r.status_code == 200
    assert r.json["providers"]["plaid"]["configured"]
    assert "plaid-secret-value" not in r.get_data(as_text=True)
    assert r.json["settings"]["plaid_secret"].endswith("alue")
    with client.application.app_context():
        assert db.session.get(Setting, "plaid_secret").value != "plaid-secret-value"
    # sending the mask back leaves the secret unchanged
    client.put("/api/bank-feeds/config", json={"plaid_secret": r.json["settings"]["plaid_secret"]})
    assert client.put("/api/bank-feeds/config", json={"plaid_countries": "USA"}).status_code == 400

    http.on("POST", "/link/token/create", {"link_token": "link-sandbox-1"})
    r = client.post("/api/bank-feeds/plaid/link-token", json={})
    assert r.json["link_token"] == "link-sandbox-1"
    sent = http.calls[-1][2]
    assert sent["secret"] == "plaid-secret-value" and sent["country_codes"] == ["US", "CA", "GB"]
    assert http.calls[-1][1].startswith("https://sandbox.plaid.com")

    http.on("POST", "/item/public_token/exchange", {"access_token": "access-sandbox-xyz", "item_id": "item1"})
    http.on("POST", "/accounts/get", {"accounts": [{"account_id": "pa1", "name": "Plaid Checking", "mask": "0000", "balances": {"current": 110.0, "iso_currency_code": "USD"}}]})
    r = client.post("/api/bank-feeds/connections", json={"provider": "plaid", "public_token": "public-sandbox-1", "institution": "Chase"})
    assert r.status_code == 201, r.json
    conn = r.json
    assert conn["institution"] == "Chase" and conn["accounts"][0]["mask"] == "0000"
    assert "access-sandbox" not in r.get_data(as_text=True)

    checking = acct(client, "1010")["id"]
    client.put(f"/api/bank-feeds/accounts/{conn['accounts'][0]['id']}", json={"account_id": checking, "sync_from": (date.today() - timedelta(days=60)).isoformat()})

    d = (date.today() - timedelta(days=3)).isoformat()
    pages = iter(
        [
            {"added": [{"transaction_id": "p1", "account_id": "pa1", "amount": 25.0, "date": d, "name": "UBER 123", "merchant_name": "Uber", "pending": False}], "modified": [], "removed": [], "next_cursor": "c1", "has_more": True, "accounts": []},
            {
                "added": [
                    {"transaction_id": "p2", "account_id": "pa1", "amount": -500.0, "date": d, "name": "Deposit", "pending": False},
                    {"transaction_id": "p3", "account_id": "pa1", "amount": 9.0, "date": d, "name": "Pending thing", "pending": True},
                ],
                "modified": [],
                "removed": [],
                "next_cursor": "c2",
                "has_more": False,
                "accounts": [{"account_id": "pa1", "balances": {"current": 585.0}}],
            },
        ]
    )
    http.on("POST", "/transactions/sync", lambda url, b: next(pages))
    r = client.post(f"/api/bank-feeds/connections/{conn['id']}/sync", json={})
    assert r.json["imported"] == 2
    assert r.json["connection"]["accounts"][0]["balance"] == 585.0
    review = {t["description"]: t["amount"] for t in client.get(f"/api/bank/transactions?account_id={checking}&status=review").json}
    assert review == {"Uber": -25.0, "Deposit": 500.0}  # Plaid's sign is flipped
    with client.application.app_context():
        assert db.session.get(BankConnection, conn["id"]).cursor == "c2"

    # next sync uses the cursor; Plaid removes p1 and corrects p2
    http.on(
        "POST",
        "/transactions/sync",
        lambda url, b: {
            "added": [],
            "modified": [{"transaction_id": "p2", "account_id": "pa1", "amount": -450.0, "date": d, "name": "Deposit", "pending": False}],
            "removed": [{"transaction_id": "p1", "account_id": "pa1"}],
            "next_cursor": "c3" if b.get("cursor") == "c2" else "wrong",
            "has_more": False,
            "accounts": [],
        },
    )
    client.post(f"/api/bank-feeds/connections/{conn['id']}/sync", json={})
    review = {t["description"]: t["amount"] for t in client.get(f"/api/bank/transactions?account_id={checking}&status=review").json}
    assert review == {"Deposit": 450.0}

    # disconnecting tells Plaid and keeps the imported transactions
    http.on("POST", "/item/remove", {"request_id": "x"})
    assert client.delete(f"/api/bank-feeds/connections/{conn['id']}").status_code == 204
    assert any("/item/remove" in c[1] for c in http.calls)
    assert client.get("/api/bank-feeds/connections").json == []
    assert len(client.get(f"/api/bank/transactions?account_id={checking}&status=review").json) == 1


def test_gocardless_flow(client, http):
    client.put("/api/bank-feeds/config", json={"gocardless_secret_id": "sid", "gocardless_secret_key": "skey"})
    http.on("POST", "/token/new/", {"access": "jwt", "refresh": "r"})
    http.on("GET", "/institutions/?country=GB", [{"id": "MONZO_MONZGB2L", "name": "Monzo", "logo": "https://logo"}])
    r = client.get("/api/bank-feeds/gocardless/institutions?country=gb")
    assert r.json == [{"id": "MONZO_MONZGB2L", "name": "Monzo", "logo": "https://logo"}]

    http.on("POST", "/requisitions/", lambda url, b: {"id": "req-1", "link": "https://ob.gocardless.com/psd2/start/req-1"})
    r = client.post("/api/bank-feeds/gocardless/start", json={"institution_id": "MONZO_MONZGB2L", "institution_name": "Monzo"})
    assert r.json["link"].endswith("req-1")
    cid = r.json["connection_id"]
    req_body = [c for c in http.calls if "/requisitions/" in c[1]][0][2]
    assert req_body["redirect"].endswith(f"/banking/connect/callback?connection={cid}")
    assert [c for c in http.calls if "/requisitions/" in c[1]][0][3]["Authorization"] == "Bearer jwt"
    # pending connections are hidden until finished
    assert client.get("/api/bank-feeds/connections").json == []

    http.on("GET", "/requisitions/req-1/", {"id": "req-1", "status": "LN", "accounts": ["ga1"]})
    http.on("GET", "/accounts/ga1/details/", {"account": {"name": "Personal Current", "currency": "GBP", "iban": "GB00MONZ12345678"}})
    r = client.post(f"/api/bank-feeds/connections/{cid}/finish", json={})
    assert r.json["status"] == "active" and r.json["accounts"][0]["name"] == "Personal Current" and r.json["accounts"][0]["mask"] == "5678"

    checking = acct(client, "1010")["id"]
    client.put(f"/api/bank-feeds/accounts/{r.json['accounts'][0]['id']}", json={"account_id": checking, "sync_from": (date.today() - timedelta(days=30)).isoformat()})
    d = (date.today() - timedelta(days=1)).isoformat()
    http.on(
        "GET",
        "/accounts/ga1/transactions/",
        {
            "transactions": {
                "booked": [
                    {"transactionId": "g1", "bookingDate": d, "transactionAmount": {"amount": "-12.30", "currency": "GBP"}, "creditorName": "Tesco", "remittanceInformationUnstructured": "Card purchase"},
                    {"bookingDate": d, "transactionAmount": {"amount": "250.00", "currency": "GBP"}, "debtorName": "ACME Ltd"},
                ],
                "pending": [{"transactionAmount": {"amount": "-1.00"}, "valueDate": d}],
            }
        },
    )
    r = client.post(f"/api/bank-feeds/connections/{cid}/sync", json={})
    assert r.json["imported"] == 2
    assert client.post(f"/api/bank-feeds/connections/{cid}/sync", json={}).json["imported"] == 0
    review = {t["description"]: t["amount"] for t in client.get(f"/api/bank/transactions?account_id={checking}&status=review").json}
    assert review == {"Tesco – Card purchase": -12.3, "ACME Ltd": 250.0}


def test_errors_mapping_and_permissions(client, http):
    token = base64.b64encode(b"https://bridge.example/claim/x").decode()
    http.on("POST", "/claim/x", "https://u:p@bridge.example/sf")
    http.on("GET", "/sf/accounts", {"errors": [], "accounts": [{"id": "a", "name": "Card", "balance": "-20", "org": {"name": "Bank"}}]})
    conn = client.post("/api/bank-feeds/connections", json={"provider": "simplefin", "setup_token": token}).json
    la = conn["accounts"][0]["id"]

    income = acct(client, "4000")["id"]
    assert client.put(f"/api/bank-feeds/accounts/{la}", json={"account_id": income}).status_code == 400

    # a provider failure marks the connection as errored with a readable message
    http.on("GET", "/sf/accounts", "Forbidden", status=403)
    client.put(f"/api/bank-feeds/accounts/{la}", json={"account_id": acct(client, "1010")["id"]})
    r = client.post(f"/api/bank-feeds/connections/{conn['id']}/sync", json={})
    assert r.status_code == 400 and "revoked" in r.json["error"]
    c = client.get("/api/bank-feeds/connections").json[0]
    assert c["status"] == "error" and "revoked" in c["last_error"]

    # non-admins can view and sync but not connect or configure
    client.post("/api/users", json={"name": "Acc", "email": "acc@example.com", "password": "password123", "role": "accountant"})
    client.post("/api/auth/logout", json={})
    client.post("/api/auth/login", json={"email": "acc@example.com", "password": "password123"})
    assert client.get("/api/bank-feeds/connections").status_code == 200
    assert "settings" not in client.get("/api/bank-feeds/config").json
    assert client.put("/api/bank-feeds/config", json={"sync_hours": 1}).status_code == 403
    assert client.post("/api/bank-feeds/connections", json={"provider": "simplefin", "setup_token": token}).status_code == 403


def test_env_credentials_take_precedence(client, http, monkeypatch):
    monkeypatch.setenv("PLAID_CLIENT_ID", "env-id")
    monkeypatch.setenv("PLAID_SECRET", "env-secret")
    monkeypatch.setenv("PLAID_ENV", "production")
    r = client.get("/api/bank-feeds/config").json
    assert r["providers"]["plaid"]["configured"] and r["providers"]["plaid"]["env"] == "production"
    assert set(r["settings"]["from_env"]) == {"plaid_client_id", "plaid_secret", "plaid_env"}
    assert "env-secret" not in str(r)
    http.on("POST", "/link/token/create", {"link_token": "lt"})
    client.post("/api/bank-feeds/plaid/link-token", json={})
    assert http.calls[-1][1].startswith("https://production.plaid.com") and http.calls[-1][2]["secret"] == "env-secret"


def test_scheduled_sync_due(app, http):
    with app.app_context():
        token = base64.b64encode(b"https://bridge.example/claim/s").decode()
        http.on("POST", "/claim/s", "https://u:p@bridge.example/sf")
        d = date.today() - timedelta(days=1)
        http.on("GET", "/sf/accounts", {"errors": [], "accounts": [{"id": "a", "name": "Chk", "balance": "1", "transactions": [{"id": "x", "posted": _epoch(d), "amount": "3.00", "description": "Interest"}]}]})
        conn = bank_feeds.simplefin_connect(token)
        from openbooks.models import Account

        conn.accounts[0].account_id = Account.query.filter_by(code="1010").first().id
        db.session.commit()
        assert bank_feeds.sync_due() == 1
        assert bank_feeds.sync_due() == 0  # synced recently, skipped


def test_http_sends_url_credentials_as_basic_auth(monkeypatch):
    seen = {}

    class Resp:
        status = 200

        def read(self):
            return b'{"ok": true}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
        return Resp()

    monkeypatch.setattr(bank_feeds.urllib.request, "urlopen", fake_urlopen)
    status, data = bank_feeds._http("GET", "https://user:pa55@bridge.example/sf/accounts?x=1")
    assert status == 200 and data == {"ok": True}
    assert seen["url"] == "https://bridge.example/sf/accounts?x=1"
    assert seen["auth"] == "Basic " + base64.b64encode(b"user:pa55").decode()
