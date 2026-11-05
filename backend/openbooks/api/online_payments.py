"""Online invoice payments through Stripe.

Nothing here is hard-coded: every OpenBooks instance uses the Stripe account
its administrator connects, either in Settings → Online payments (stored in
the database) or with environment variables, which take precedence:

    STRIPE_SECRET_KEY        sk_live_… / sk_test_… (or a restricted rk_… key)
    STRIPE_PUBLISHABLE_KEY   pk_live_… / pk_test_…
    STRIPE_WEBHOOK_SECRET    whsec_…
    PUBLIC_URL               https://books.example.com (used in links and redirects)

Flow: an invoice gets an unguessable pay link (/pay/<token>). The customer opens
it without logging in, clicks Pay, and is sent to a Stripe Checkout page. When
Stripe confirms the payment (webhook, or the redirect back as a fallback), the
payment is recorded against the invoice and deposited to the chosen account.
Secret keys are never returned to the browser.
"""
import logging
import os
import secrets
from datetime import date

import stripe
from flask import current_app, jsonify, request

from ..models import Account, Invoice, Payment, Setting, db, money
from ..util import ApiError, body, get_or_404
from . import bp, require_admin

log = logging.getLogger("openbooks.stripe")

SECRET_SETTINGS = ("stripe_secret_key", "stripe_webhook_secret")
CONFIG_SETTINGS = ("stripe_enabled", "stripe_publishable_key", "stripe_deposit_account_id", "public_url") + SECRET_SETTINGS
ENV_NAMES = {
    "stripe_secret_key": "STRIPE_SECRET_KEY",
    "stripe_publishable_key": "STRIPE_PUBLISHABLE_KEY",
    "stripe_webhook_secret": "STRIPE_WEBHOOK_SECRET",
    "public_url": "PUBLIC_URL",
}
# Currencies Stripe charges in whole units (no cents)
ZERO_DECIMAL = {"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"}


# ---------------------------------------------------------------- configuration


def _stored(key):
    row = db.session.get(Setting, key)
    return row.value if row else ""


def cfg(key):
    """Environment variable first, then the value saved in Settings."""
    env = ENV_NAMES.get(key)
    if env and os.environ.get(env):
        return os.environ[env].strip()
    return _stored(key).strip()


def _set(key, value):
    row = db.session.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        db.session.add(row)
    row.value = value


def _mask(value):
    if not value:
        return None
    return f"{value[:8]}…{value[-4:]}" if len(value) > 14 else "••••"


def stripe_ready():
    return cfg("stripe_enabled") == "true" and bool(cfg("stripe_secret_key")) and bool(cfg("stripe_deposit_account_id"))


def _client():
    key = cfg("stripe_secret_key")
    if not key:
        raise ApiError("Stripe is not connected. An administrator can add the keys in Settings → Online payments.")
    return stripe.StripeClient(key)


def _base_url():
    url = cfg("public_url") or request.host_url
    return url.rstrip("/")


def _mode(key):
    if not key:
        return None
    return "live" if "_live_" in key else "test"


def public_config():
    """Non-secret summary used by the rest of the app."""
    from .assistant import assistant_ready

    return {
        "online_payments_enabled": stripe_ready(),
        "stripe_mode": _mode(cfg("stripe_secret_key")),
        "assistant_enabled": assistant_ready(),
    }


@bp.get("/stripe/config")
def get_stripe_config():
    require_admin()
    secret = cfg("stripe_secret_key")
    account_id = cfg("stripe_deposit_account_id")
    account = db.session.get(Account, int(account_id)) if account_id.isdigit() else None
    return jsonify(
        {
            "enabled": cfg("stripe_enabled") == "true",
            "ready": stripe_ready(),
            "mode": _mode(secret),
            "publishable_key": cfg("stripe_publishable_key"),
            "secret_key_saved": _mask(secret),
            "webhook_secret_saved": _mask(cfg("stripe_webhook_secret")),
            "deposit_account_id": account.id if account else None,
            "public_url": cfg("public_url"),
            "webhook_url": f"{_base_url()}/api/stripe/webhook",
            "from_environment": {k: bool(os.environ.get(v)) for k, v in ENV_NAMES.items()},
        }
    )


@bp.put("/stripe/config")
def update_stripe_config():
    require_admin()
    data = body()
    if "secret_key" in data and data["secret_key"]:
        key = str(data["secret_key"]).strip()
        if not key.startswith(("sk_test_", "sk_live_", "rk_test_", "rk_live_")):
            raise ApiError("The secret key should start with sk_test_, sk_live_, rk_test_ or rk_live_")
        _set("stripe_secret_key", key)
    if "publishable_key" in data:
        key = str(data["publishable_key"] or "").strip()
        if key and not key.startswith(("pk_test_", "pk_live_")):
            raise ApiError("The publishable key should start with pk_test_ or pk_live_")
        _set("stripe_publishable_key", key)
    if "webhook_secret" in data and data["webhook_secret"]:
        secret = str(data["webhook_secret"]).strip()
        if not secret.startswith("whsec_"):
            raise ApiError("The webhook signing secret should start with whsec_")
        _set("stripe_webhook_secret", secret)
    for name in data.get("clear") or []:
        if name in ("secret_key", "webhook_secret"):
            _set(f"stripe_{name}", "")
    if "deposit_account_id" in data:
        account = db.session.get(Account, data.get("deposit_account_id")) if data.get("deposit_account_id") else None
        if data.get("deposit_account_id") and (account is None or account.subtype not in ("bank", "cash")):
            raise ApiError("Choose a bank account for Stripe payments")
        _set("stripe_deposit_account_id", str(account.id) if account else "")
    if "public_url" in data:
        url = str(data["public_url"] or "").strip().rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            raise ApiError("The public URL must start with http:// or https://")
        _set("public_url", url)
    if "enabled" in data:
        enabled = bool(data["enabled"])
        if enabled and not cfg("stripe_secret_key"):
            raise ApiError("Add your Stripe secret key before turning on online payments")
        if enabled and not cfg("stripe_deposit_account_id"):
            raise ApiError("Choose the bank account Stripe payments are deposited to")
        _set("stripe_enabled", "true" if enabled else "false")
    db.session.commit()
    return get_stripe_config()


@bp.post("/stripe/test")
def test_stripe_connection():
    require_admin()
    try:
        account = _client().accounts.retrieve_current()
    except stripe.error.AuthenticationError:
        raise ApiError("Stripe rejected the secret key. Check that you copied it correctly.")
    except stripe.error.APIConnectionError:
        raise ApiError("Could not reach Stripe from this server. Check that it has internet access.")
    except stripe.error.StripeError as exc:
        raise ApiError(f"Stripe error: {exc.user_message or type(exc).__name__}")
    settings = account.get("settings") or {}
    dashboard = settings.get("dashboard") or {}
    return jsonify(
        {
            "ok": True,
            "account_id": account.get("id"),
            "name": dashboard.get("display_name") or (account.get("business_profile") or {}).get("name") or account.get("email"),
            "charges_enabled": account.get("charges_enabled"),
            "mode": _mode(cfg("stripe_secret_key")),
        }
    )


# ---------------------------------------------------------------- pay links (signed-in users)


@bp.post("/invoices/<int:invoice_id>/payment-link")
def invoice_payment_link(invoice_id):
    invoice = get_or_404(Invoice, invoice_id, "Invoice")
    if invoice.kind != "invoice" or invoice.status != "open":
        raise ApiError("Only finalised invoices can be paid online")
    if not stripe_ready():
        raise ApiError("Online payments are not set up. An administrator can connect Stripe in Settings → Online payments.")
    if not invoice.pay_token:
        invoice.pay_token = secrets.token_urlsafe(24)
        db.session.commit()
    return jsonify({"url": f"{_base_url()}/pay/{invoice.pay_token}"})


# ---------------------------------------------------------------- public pay page (no login)


def _invoice_for_token(token):
    invoice = Invoice.query.filter_by(pay_token=token).first() if token else None
    if invoice is None or invoice.kind != "invoice" or invoice.status == "draft":
        raise ApiError("This payment link is not valid", 404)
    return invoice


@bp.get("/public/invoices/<token>")
def public_invoice(token):
    from .settings import get_settings

    invoice = _invoice_for_token(token)
    s = get_settings()
    return jsonify(
        {
            "company": {k: s.get(f"company_{k}", "") for k in ("name", "email", "phone", "address")},
            "currency": s.get("currency", "USD"),
            "number": invoice.number,
            "customer": invoice.customer.name,
            "date": invoice.date.isoformat(),
            "due_date": invoice.due_date.isoformat(),
            "status": invoice.display_status,
            "lines": [
                {"description": l.description or (l.item.name if l.item else ""), "quantity": l.quantity, "unit_price": money(l.unit_price_cents), "amount": money(l.amount_cents)}
                for l in invoice.lines
            ],
            "subtotal": money(invoice.subtotal_cents),
            "tax": money(invoice.tax_cents),
            "total": money(invoice.total_cents),
            "paid": money(invoice.paid_cents),
            "balance": money(invoice.balance_cents),
            "memo": invoice.memo,
            "can_pay": stripe_ready() and invoice.balance_cents > 0 and invoice.status == "open",
        }
    )


def _to_stripe_amount(cents, currency):
    return cents // 100 if currency in ZERO_DECIMAL else cents


def _from_stripe_amount(amount, currency):
    return amount * 100 if currency in ZERO_DECIMAL else amount


@bp.post("/public/invoices/<token>/checkout")
def public_checkout(token):
    from .settings import get_settings

    invoice = _invoice_for_token(token)
    if not stripe_ready():
        raise ApiError("Online payment is not available for this invoice")
    if invoice.status != "open" or invoice.balance_cents <= 0:
        raise ApiError("This invoice has already been paid")
    currency = get_settings().get("currency", "USD").lower()
    amount = _to_stripe_amount(invoice.balance_cents, currency)
    base = _base_url()
    company = get_settings().get("company_name", "")
    params = {
        "mode": "payment",
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": currency,
                    "unit_amount": amount,
                    "product_data": {"name": f"Invoice {invoice.number}", "description": f"{company} · {invoice.customer.name}"[:500]},
                },
            }
        ],
        "client_reference_id": str(invoice.id),
        "metadata": {"openbooks_invoice_id": str(invoice.id), "openbooks_pay_token": token},
        "payment_intent_data": {
            "description": f"Invoice {invoice.number}",
            "metadata": {"openbooks_invoice_id": str(invoice.id)},
        },
        "success_url": f"{base}/pay/{token}?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{base}/pay/{token}?canceled=1",
    }
    if invoice.customer.email:
        params["customer_email"] = invoice.customer.email
    try:
        session = _client().checkout.sessions.create(params=params)
    except stripe.error.StripeError as exc:
        # Log the details for the administrator; never show server internals to the customer
        log.warning("Stripe checkout failed for invoice %s: %s", invoice.number, exc)
        raise ApiError("Online payment is temporarily unavailable. Please try again later or contact us to pay another way.", 502)
    return jsonify({"url": session.url})


def record_checkout_session(session):
    """Record a completed Checkout Session as a payment. Safe to call more than once."""
    from .sales import save_payment

    if session.get("payment_status") != "paid":
        return None
    metadata = session.get("metadata") or {}
    invoice_id = metadata.get("openbooks_invoice_id") or session.get("client_reference_id")
    invoice = db.session.get(Invoice, int(invoice_id)) if invoice_id and str(invoice_id).isdigit() else None
    if invoice is None:
        log.warning("Stripe session %s does not reference an OpenBooks invoice", session.get("id"))
        return None
    reference = session.get("payment_intent") or session.get("id")
    if isinstance(reference, dict):
        reference = reference.get("id")
    if Payment.query.filter_by(invoice_id=invoice.id, reference=reference).first():
        return None  # already recorded
    currency = (session.get("currency") or "usd").lower()
    cents = _from_stripe_amount(int(session.get("amount_total") or 0), currency)
    amount = min(cents, invoice.balance_cents)
    if amount <= 0:
        log.warning("Stripe payment %s for invoice %s arrived after it was fully paid", reference, invoice.number)
        return None
    account_id = cfg("stripe_deposit_account_id")
    payment = save_payment(
        invoice,
        {"date": date.today().isoformat(), "amount": amount / 100, "account_id": int(account_id), "method": "Stripe", "reference": reference},
    )
    db.session.commit()
    log.info("Recorded Stripe payment %s on invoice %s", reference, invoice.number)
    return payment


@bp.post("/public/invoices/<token>/confirm")
def public_confirm(token):
    """Called when the customer is redirected back from Stripe Checkout.

    The webhook is the main way payments are recorded; this is a fallback so a
    payment still shows up immediately even if webhooks are not configured.
    """
    invoice = _invoice_for_token(token)
    session_id = str(body().get("session_id") or "")
    if not session_id.startswith("cs_"):
        raise ApiError("Missing checkout session")
    try:
        session = _client().checkout.sessions.retrieve(session_id)
    except stripe.error.StripeError:
        raise ApiError("Could not confirm the payment with Stripe", 502)
    if (session.get("metadata") or {}).get("openbooks_invoice_id") != str(invoice.id):
        raise ApiError("That payment does not belong to this invoice", 400)
    record_checkout_session(session)
    db.session.refresh(invoice)
    return jsonify({"paid": session.get("payment_status") == "paid", "balance": money(invoice.balance_cents)})


@bp.post("/stripe/webhook")
def stripe_webhook():
    secret = cfg("stripe_webhook_secret")
    if not secret:
        log.warning("Stripe webhook received but no webhook signing secret is configured")
        return jsonify({"error": "Webhook signing secret not configured"}), 400
    payload = request.get_data()
    try:
        event = stripe.Webhook.construct_event(payload, request.headers.get("Stripe-Signature", ""), secret)
    except (ValueError, stripe.error.SignatureVerificationError):
        return jsonify({"error": "Invalid signature"}), 400
    if event["type"] in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        try:
            record_checkout_session(event["data"]["object"])
        except ApiError as exc:
            # e.g. the invoice was voided; acknowledge so Stripe stops retrying, but log it
            db.session.rollback()
            current_app.logger.warning("Stripe payment could not be applied: %s", exc.message)
    return jsonify({"received": True})
