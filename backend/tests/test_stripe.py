import hashlib
import hmac
import json
import time

import pytest

from openbooks import create_app
from openbooks.api import online_payments
from tests.test_api import acct


class FakeSessions:
    def __init__(self):
        self.created = []
        self.sessions = {}

    def create(self, params):
        self.created.append(params)
        sid = f"cs_test_{len(self.created)}"
        self.sessions[sid] = {
            "id": sid,
            "payment_status": "paid",
            "payment_intent": f"pi_{len(self.created)}",
            "currency": params["line_items"][0]["price_data"]["currency"],
            "amount_total": params["line_items"][0]["price_data"]["unit_amount"],
            "metadata": params["metadata"],
            "client_reference_id": params["client_reference_id"],
        }
        return type("S", (), {"url": f"https://checkout.stripe.test/{sid}", "id": sid})()

    def retrieve(self, sid):
        return self.sessions[sid]


class FakeClient:
    def __init__(self):
        self.checkout = type("C", (), {})()
        self.checkout.sessions = FakeSessions()
        self.accounts = type("A", (), {"retrieve_current": lambda self: {"id": "acct_123", "email": "owner@example.com", "charges_enabled": True}})()


@pytest.fixture
def env(tmp_path, monkeypatch):
    for var in ("DEMO_DATA", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "PUBLIC_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    fake = FakeClient()
    monkeypatch.setattr(online_payments, "_client", lambda: fake)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    admin = app.test_client()
    admin.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return app, admin, fake


def _connect(admin):
    r = admin.put(
        "/api/stripe/config",
        json={
            "secret_key": "sk_test_abcdefghijklmnop1234",
            "publishable_key": "pk_test_abc",
            "webhook_secret": "whsec_testsecret",
            "deposit_account_id": acct(admin, "1010")["id"],
            "public_url": "https://books.example.com",
            "enabled": True,
        },
    )
    assert r.status_code == 200, r.json
    return r.json


def _invoice(admin, amount=250):
    cid = admin.post("/api/customers", json={"name": "Acme", "email": "ap@acme.test"}).json["id"]
    return admin.post(
        "/api/invoices",
        json={"customer_id": cid, "date": "2026-01-01", "lines": [{"description": "Work", "quantity": 1, "unit_price": amount, "account_id": acct(admin, "4100")["id"]}]},
    ).json


def test_config_is_per_instance_and_secrets_never_returned(env):
    _, admin, _ = env
    cfg = admin.get("/api/stripe/config").json
    assert cfg["ready"] is False and cfg["secret_key_saved"] is None
    # cannot enable without keys
    assert admin.put("/api/stripe/config", json={"enabled": True}).status_code == 400
    # rejects obviously wrong keys
    assert admin.put("/api/stripe/config", json={"secret_key": "pk_test_wrong"}).status_code == 400

    saved = _connect(admin)
    assert saved["ready"] and saved["mode"] == "test"
    assert saved["webhook_url"] == "https://books.example.com/api/stripe/webhook"
    everything = json.dumps([saved, admin.get("/api/settings").json])
    assert "sk_test_abcdefghijklmnop1234" not in everything
    assert "whsec_testsecret" not in everything
    assert admin.get("/api/settings").json["online_payments_enabled"] is True
    assert admin.post("/api/stripe/test", json={}).json["account_id"] == "acct_123"


def test_environment_variables_take_precedence(env, monkeypatch):
    _, admin, _ = env
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_fromenvironment9999")
    cfg = admin.get("/api/stripe/config").json
    assert cfg["mode"] == "live" and cfg["from_environment"]["stripe_secret_key"]


def test_only_admins_can_configure(env):
    app, admin, _ = env
    admin.post("/api/users", json={"email": "acc@x.com", "name": "Acc", "password": "password123", "role": "accountant"})
    other = app.test_client()
    other.post("/api/auth/login", json={"email": "acc@x.com", "password": "password123"})
    assert other.get("/api/stripe/config").status_code == 403
    assert other.put("/api/stripe/config", json={"enabled": False}).status_code == 403


def test_pay_link_checkout_and_redirect_confirm(env):
    app, admin, fake = env
    inv = _invoice(admin)
    # not available until Stripe is connected
    assert admin.post(f"/api/invoices/{inv['id']}/payment-link", json={}).status_code == 400
    _connect(admin)
    url = admin.post(f"/api/invoices/{inv['id']}/payment-link", json={}).json["url"]
    assert url.startswith("https://books.example.com/pay/")
    token = url.rsplit("/", 1)[1]

    public = app.test_client()  # the customer: not logged in
    page = public.get(f"/api/public/invoices/{token}").json
    assert page["can_pay"] and page["balance"] == 250 and page["number"] == inv["number"]
    assert "lines" in page and "account" not in page["lines"][0]
    assert public.get("/api/public/invoices/not-a-real-token").status_code == 404

    checkout = public.post(f"/api/public/invoices/{token}/checkout", json={})
    assert checkout.status_code == 200, checkout.json
    params = fake.checkout.sessions.created[0]
    assert params["line_items"][0]["price_data"]["unit_amount"] == 25000
    assert params["line_items"][0]["price_data"]["currency"] == "usd"
    assert params["customer_email"] == "ap@acme.test"
    assert params["success_url"].startswith(f"https://books.example.com/pay/{token}")

    confirmed = public.post(f"/api/public/invoices/{token}/confirm", json={"session_id": "cs_test_1"}).json
    assert confirmed["paid"] and confirmed["balance"] == 0
    # calling again does not double-record
    public.post(f"/api/public/invoices/{token}/confirm", json={"session_id": "cs_test_1"})
    invoice = admin.get(f"/api/invoices/{inv['id']}").json
    assert invoice["status"] == "paid" and len(invoice["payments"]) == 1
    assert invoice["payments"][0]["method"] == "Stripe"
    assert acct(admin, "1010")["balance"] == 250
    assert public.post(f"/api/public/invoices/{token}/checkout", json={}).status_code == 400  # already paid


def _signed(payload, secret="whsec_testsecret"):
    ts = int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.{payload}".encode(), hashlib.sha256).hexdigest()
    return {"Stripe-Signature": f"t={ts},v1={sig}", "Content-Type": "application/json"}


def test_webhook_verifies_signature_and_records_payment(env):
    app, admin, _ = env
    inv = _invoice(admin, amount=80)
    _connect(admin)
    event = {
        "id": "evt_1",
        "object": "event",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_hook",
                "object": "checkout.session",
                "payment_status": "paid",
                "payment_intent": "pi_hook",
                "currency": "usd",
                "amount_total": 8000,
                "metadata": {"openbooks_invoice_id": str(inv["id"])},
            }
        },
    }
    payload = json.dumps(event)
    stripe_server = app.test_client()
    bad = stripe_server.post("/api/stripe/webhook", data=payload, headers=_signed(payload, "whsec_wrong"))
    assert bad.status_code == 400
    assert admin.get(f"/api/invoices/{inv['id']}").json["balance"] == 80

    ok = stripe_server.post("/api/stripe/webhook", data=payload, headers=_signed(payload))
    assert ok.status_code == 200, ok.json
    # Stripe retries webhooks; a repeat must not record twice
    stripe_server.post("/api/stripe/webhook", data=payload, headers=_signed(payload))
    invoice = admin.get(f"/api/invoices/{inv['id']}").json
    assert invoice["balance"] == 0 and len(invoice["payments"]) == 1
    assert admin.get("/api/reports/balance-sheet").json["balanced"]


def test_zero_decimal_currency(env):
    _, admin, fake = env
    admin.put("/api/settings", json={"currency": "JPY"})
    inv = _invoice(admin, amount=5000)
    _connect(admin)
    token = admin.post(f"/api/invoices/{inv['id']}/payment-link", json={}).json["url"].rsplit("/", 1)[1]
    admin.post(f"/api/public/invoices/{token}/checkout", json={})
    assert fake.checkout.sessions.created[0]["line_items"][0]["price_data"]["unit_amount"] == 5000


def test_public_page_never_shows_stripe_internals(env, monkeypatch):
    import stripe

    app, admin, fake = env
    inv = _invoice(admin)
    _connect(admin)
    token = admin.post(f"/api/invoices/{inv['id']}/payment-link", json={}).json["url"].rsplit("/", 1)[1]

    def boom(params):
        raise stripe.error.APIConnectionError("ProxyError: HTTPSConnectionPool(host='api.stripe.com') secret details")

    monkeypatch.setattr(fake.checkout.sessions, "create", boom)
    r = app.test_client().post(f"/api/public/invoices/{token}/checkout", json={})
    assert r.status_code == 502
    assert "Proxy" not in r.json["error"] and "api.stripe.com" not in r.json["error"]
