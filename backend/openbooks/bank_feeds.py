"""Bank feeds: pull transactions from banks through a bank-data provider.

Providers (each OpenBooks host brings its own account; nothing is hard-coded):

  simplefin   SimpleFIN Bridge (US). The user creates a setup token in SimpleFIN
              and pastes it in; no developer credentials are needed.
  plaid       Plaid (US, Canada, UK, Europe). Needs the host's Plaid client ID and
              secret; the user picks their bank in Plaid Link.
  gocardless  GoCardless Bank Account Data (UK / EU). Needs the host's secret ID and
              key; the user approves access on their bank's website and returns.

Imported transactions go to Banking → For review like a CSV import. Each one keeps
the provider's transaction ID so re-syncing never duplicates anything. Pending
transactions are skipped until they post. Amounts are stored with OpenBooks' sign
convention: positive = money into the account, negative = money out.
"""
import base64
import hashlib
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from cryptography.fernet import Fernet, InvalidToken

from .models import BankConnection, BankTransaction, LinkedBankAccount, Setting, db
from .util import ApiError

log = logging.getLogger("openbooks.bank_feeds")

PROVIDERS = ("simplefin", "plaid", "gocardless")
PLAID_URLS = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}
GOCARDLESS_URL = "https://bankaccountdata.gocardless.com/api/v2"
HTTP_TIMEOUT = 45


# ---------------------------------------------------------------- settings & secrets


def _setting(key, default=""):
    row = db.session.get(Setting, key)
    return row.value if row and row.value is not None else default


def _set(key, value):
    row = db.session.get(Setting, key) or Setting(key=key)
    row.value = value
    db.session.add(row)


ENV = {
    "plaid_client_id": "PLAID_CLIENT_ID",
    "plaid_secret": "PLAID_SECRET",
    "plaid_env": "PLAID_ENV",
    "gocardless_secret_id": "GOCARDLESS_SECRET_ID",
    "gocardless_secret_key": "GOCARDLESS_SECRET_KEY",
}
SECRET_KEYS = ("plaid_secret", "gocardless_secret_key")


def cfg(key):
    env = ENV.get(key)
    if env and os.environ.get(env):
        return os.environ[env].strip()
    value = _setting(key)
    if key in SECRET_KEYS and value:
        try:
            return decrypt(value)
        except ApiError:
            return ""
    return value


def _fernet():
    from flask import current_app

    key = hashlib.sha256(("openbooks-bank-feeds:" + current_app.config["SECRET_KEY"]).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value):
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token):
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        raise ApiError("Stored bank credentials can't be read (the server's SECRET_KEY changed). Reconnect this bank.")


def _secret(conn):
    return json.loads(decrypt(conn.secret)) if conn.secret else {}


def _set_secret(conn, data):
    conn.secret = encrypt(json.dumps(data))


def provider_status():
    return {
        "simplefin": {"configured": True},
        "plaid": {
            "configured": bool(cfg("plaid_client_id") and cfg("plaid_secret")),
            "env": cfg("plaid_env") or "sandbox",
            "countries": _setting("plaid_countries", "US"),
        },
        "gocardless": {"configured": bool(cfg("gocardless_secret_id") and cfg("gocardless_secret_key"))},
    }


# ---------------------------------------------------------------- HTTP (stdlib, so no extra dependency)


def _http(method, url, *, json_body=None, headers=None, form=None):
    """Make an HTTP request and return (status, parsed JSON or text). Replaced in tests."""
    headers = dict(headers or {})
    data = None
    parsed = urllib.parse.urlsplit(url)
    if parsed.username:  # SimpleFIN access URLs carry basic-auth credentials
        creds = f"{urllib.parse.unquote(parsed.username)}:{urllib.parse.unquote(parsed.password or '')}"
        headers["Authorization"] = "Basic " + base64.b64encode(creds.encode()).decode()
        netloc = parsed.hostname + (f":{parsed.port}" if parsed.port else "")
        url = urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
    headers.setdefault("Accept", "application/json")
    headers.setdefault("User-Agent", "OpenBooks bank feeds")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            status, raw = resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read().decode(errors="replace")
    except urllib.error.URLError as exc:
        raise ApiError(f"Could not reach the bank-data provider: {exc.reason}", 502)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def _check(status, body, provider):
    if 200 <= status < 300:
        return body
    detail = ""
    if isinstance(body, dict):
        detail = body.get("error_message") or body.get("detail") or body.get("summary") or body.get("error") or ""
    raise ApiError(f"{provider} returned an error ({status}){': ' + str(detail) if detail else ''}", 502)


def _cents(amount):
    from decimal import ROUND_HALF_UP, Decimal

    return int((Decimal(str(amount)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------- SimpleFIN


def simplefin_connect(setup_token):
    token = (setup_token or "").strip()
    try:
        claim_url = base64.b64decode(token, validate=False).decode().strip()
    except (ValueError, UnicodeDecodeError):
        raise ApiError("That doesn't look like a SimpleFIN setup token")
    if not claim_url.startswith("https://"):
        raise ApiError("That doesn't look like a SimpleFIN setup token")
    status, body = _http("POST", claim_url, headers={"Accept": "text/plain"})
    if status == 403:
        raise ApiError("SimpleFIN rejected the setup token. Setup tokens work only once. Create a new one and try again.")
    access_url = str(_check(status, body, "SimpleFIN")).strip()
    if not access_url.startswith("https://"):
        raise ApiError("SimpleFIN returned an unexpected response")
    conn = BankConnection(provider="simplefin", institution="SimpleFIN", status="active")
    _set_secret(conn, {"access_url": access_url})
    db.session.add(conn)
    db.session.flush()
    _simplefin_refresh_accounts(conn)
    return conn


def _simplefin_get(conn, params):
    access = _secret(conn)["access_url"].rstrip("/")
    status, body = _http("GET", f"{access}/accounts?{urllib.parse.urlencode(params)}")
    if status == 403:
        raise ApiError("SimpleFIN access was revoked. Reconnect this bank with a new setup token.")
    body = _check(status, body, "SimpleFIN")
    errors = body.get("errors") or []
    if errors:
        conn.last_error = "; ".join(str(e) for e in errors)[:1000]
    return body.get("accounts") or []


def _simplefin_refresh_accounts(conn):
    accounts = _simplefin_get(conn, {"balances-only": 1})
    orgs = {((a.get("org") or {}).get("name") or "") for a in accounts}
    conn.institution = ", ".join(sorted(o for o in orgs if o)) or "SimpleFIN"
    for a in accounts:
        _upsert_linked(conn, a["id"], a.get("name") or "Account", "", a.get("currency") or "", a.get("balance"))


def _simplefin_sync(conn, linked, since):
    rows = []
    params = {"start-date": int(datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc).timestamp())}
    accounts = _simplefin_get(conn, params)
    for a in accounts:
        la = linked.get(a.get("id"))
        if la is None:
            continue
        if a.get("balance") is not None:
            la.balance_cents = _cents(a["balance"])
        for t in a.get("transactions") or []:
            if t.get("pending"):
                continue
            posted = t.get("posted") or t.get("transacted_at")
            if not posted:
                continue
            day = datetime.fromtimestamp(int(posted), tz=timezone.utc).date()
            desc = t.get("payee") or t.get("description") or t.get("memo") or ""
            if t.get("payee") and t.get("description") and t["description"] != t["payee"]:
                desc = f"{t['payee']} – {t['description']}"
            rows.append((la, str(t["id"]), day, desc, _cents(t["amount"])))  # SimpleFIN: negative = money out
    return rows, []


# ---------------------------------------------------------------- Plaid


def _plaid(path, payload):
    env = (cfg("plaid_env") or "sandbox").lower()
    base = PLAID_URLS.get(env)
    if base is None:
        raise ApiError("Plaid environment must be sandbox or production")
    if not (cfg("plaid_client_id") and cfg("plaid_secret")):
        raise ApiError("Add your Plaid client ID and secret in Settings → Bank connections first")
    body = {"client_id": cfg("plaid_client_id"), "secret": cfg("plaid_secret"), **payload}
    status, resp = _http("POST", f"{base}{path}", json_body=body)
    if isinstance(resp, dict) and resp.get("error_code") == "ITEM_LOGIN_REQUIRED":
        raise ApiError("The bank needs you to sign in again. Disconnect and reconnect this bank.", 409)
    return _check(status, resp, "Plaid")


def plaid_link_token(user_id):
    countries = [c.strip().upper() for c in _setting("plaid_countries", "US").split(",") if c.strip()]
    resp = _plaid(
        "/link/token/create",
        {
            "client_name": (_setting("company_name") or "OpenBooks")[:30],
            "language": "en",
            "country_codes": countries or ["US"],
            "user": {"client_user_id": f"openbooks-user-{user_id}"},
            "products": ["transactions"],
            "transactions": {"days_requested": 730},
        },
    )
    return resp["link_token"]


def plaid_connect(public_token, institution=""):
    resp = _plaid("/item/public_token/exchange", {"public_token": public_token})
    conn = BankConnection(provider="plaid", institution=institution or "Bank (Plaid)", status="active")
    _set_secret(conn, {"access_token": resp["access_token"], "item_id": resp["item_id"]})
    db.session.add(conn)
    db.session.flush()
    accounts = _plaid("/accounts/get", {"access_token": resp["access_token"]}).get("accounts") or []
    for a in accounts:
        bal = (a.get("balances") or {}).get("current")
        _upsert_linked(conn, a["account_id"], a.get("name") or "Account", a.get("mask") or "", (a.get("balances") or {}).get("iso_currency_code") or "", bal)
    return conn


def _plaid_sync(conn, linked, since):
    access = _secret(conn)["access_token"]
    rows, removed = [], []
    cursor = conn.cursor or None
    for _ in range(50):  # pages
        payload = {"access_token": access, "count": 500}
        if cursor:
            payload["cursor"] = cursor
        resp = _plaid("/transactions/sync", payload)
        for a in resp.get("accounts") or []:
            la = linked.get(a.get("account_id"))
            if la and (a.get("balances") or {}).get("current") is not None:
                la.balance_cents = _cents(a["balances"]["current"])
        for t in (resp.get("added") or []) + (resp.get("modified") or []):
            la = linked.get(t.get("account_id"))
            if la is None or t.get("pending"):
                continue
            day = date.fromisoformat(str(t["date"])[:10])
            desc = t.get("merchant_name") or t.get("name") or ""
            rows.append((la, t["transaction_id"], day, desc, -_cents(t["amount"])))  # Plaid: positive = money out
        removed.extend(r["transaction_id"] for r in resp.get("removed") or [] if r.get("transaction_id"))
        cursor = resp.get("next_cursor") or cursor
        if not resp.get("has_more"):
            break
    conn.cursor = cursor or ""
    return rows, removed


# ---------------------------------------------------------------- GoCardless Bank Account Data


def _gc_token():
    if not (cfg("gocardless_secret_id") and cfg("gocardless_secret_key")):
        raise ApiError("Add your GoCardless secret ID and key in Settings → Bank connections first")
    status, body = _http("POST", f"{GOCARDLESS_URL}/token/new/", json_body={"secret_id": cfg("gocardless_secret_id"), "secret_key": cfg("gocardless_secret_key")})
    return _check(status, body, "GoCardless")["access"]


def _gc(method, path, token, payload=None):
    status, body = _http(method, f"{GOCARDLESS_URL}{path}", json_body=payload, headers={"Authorization": f"Bearer {token}"})
    return _check(status, body, "GoCardless")


def gocardless_institutions(country):
    country = (country or "").strip().upper()
    if len(country) != 2:
        raise ApiError("Choose a country")
    data = _gc("GET", f"/institutions/?country={country}", _gc_token())
    return [{"id": i["id"], "name": i.get("name", i["id"]), "logo": i.get("logo", "")} for i in data]


def gocardless_start(institution_id, institution_name, redirect_base):
    conn = BankConnection(provider="gocardless", institution=institution_name or institution_id, status="pending")
    db.session.add(conn)
    db.session.flush()
    token = _gc_token()
    req = _gc(
        "POST",
        "/requisitions/",
        token,
        {"redirect": f"{redirect_base}/banking/connect/callback?connection={conn.id}", "institution_id": institution_id, "reference": f"openbooks-{conn.id}-{int(time.time())}"},
    )
    _set_secret(conn, {"requisition_id": req["id"]})
    return conn, req["link"]


def gocardless_finish(conn):
    token = _gc_token()
    req = _gc("GET", f"/requisitions/{_secret(conn)['requisition_id']}/", token)
    account_ids = req.get("accounts") or []
    if not account_ids:
        raise ApiError("The bank didn't share any accounts. Try connecting again and approve access.")
    for acc_id in account_ids:
        name, currency, mask = "Account", "", ""
        try:
            details = _gc("GET", f"/accounts/{acc_id}/details/", token).get("account") or {}
            name = details.get("name") or details.get("product") or details.get("ownerName") or name
            currency = details.get("currency") or ""
            iban = details.get("iban") or ""
            mask = iban[-4:] if iban else ""
        except ApiError as exc:
            log.warning("GoCardless account details unavailable: %s", exc.message)
        _upsert_linked(conn, acc_id, name, mask, currency, None)
    conn.status = "active"
    return conn


def _gc_sync(conn, linked, since):
    token = _gc_token()
    rows = []
    for ext_id, la in linked.items():
        data = _gc("GET", f"/accounts/{ext_id}/transactions/?date_from={since.isoformat()}", token)
        for t in (data.get("transactions") or {}).get("booked") or []:
            day_text = t.get("bookingDate") or t.get("valueDate")
            if not day_text:
                continue
            ext = t.get("transactionId") or t.get("internalTransactionId")
            if not ext:
                # stable fallback when the bank gives no ID
                ext = "h:" + hashlib.sha1(json.dumps(t, sort_keys=True).encode()).hexdigest()
            info = t.get("remittanceInformationUnstructured") or " ".join(t.get("remittanceInformationUnstructuredArray") or [])
            desc = t.get("creditorName") or t.get("debtorName") or info or ""
            if info and desc != info:
                desc = f"{desc} – {info}" if desc else info
            amount = (t.get("transactionAmount") or {}).get("amount", 0)
            rows.append((la, str(ext), date.fromisoformat(day_text[:10]), desc, _cents(amount)))  # negative = money out
    return rows, []


# ---------------------------------------------------------------- shared sync


def _upsert_linked(conn, external_id, name, mask, currency, balance):
    la = LinkedBankAccount.query.filter_by(connection_id=conn.id, external_id=str(external_id)).first()
    if la is None:
        la = LinkedBankAccount(connection_id=conn.id, external_id=str(external_id), sync_from=date.today() - timedelta(days=30))
        db.session.add(la)
        conn.accounts.append(la)
    la.name = name[:255]
    la.mask = (mask or "")[:16]
    la.currency = (currency or "")[:8]
    if balance is not None:
        la.balance_cents = _cents(balance)
    return la


SYNCERS = {"simplefin": _simplefin_sync, "plaid": _plaid_sync, "gocardless": _gc_sync}


def sync_connection(conn):
    """Pull new transactions for one connection. Returns the number imported."""
    if conn.status not in ("active", "error"):
        return 0
    linked = {la.external_id: la for la in conn.accounts if la.active and la.account_id}
    if not linked:
        conn.last_synced_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.session.commit()
        return 0
    # look back a week past the last sync to catch transactions that posted late
    earliest = min(la.sync_from or date.today() for la in linked.values())
    since = earliest
    if conn.last_synced_at:
        since = max(earliest, conn.last_synced_at.date() - timedelta(days=7))
    conn.last_error = ""  # SimpleFIN may set a partial-failure note during the fetch
    try:
        rows, removed = SYNCERS[conn.provider](conn, linked, since)
    except ApiError as exc:
        db.session.rollback()
        conn = db.session.get(BankConnection, conn.id)
        conn.status = "error"
        conn.last_error = exc.message
        conn.last_synced_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.session.commit()
        raise
    imported = 0
    for la, ext_id, day, desc, cents in rows:
        if (la.sync_from and day < la.sync_from) or cents == 0:
            continue
        existing = BankTransaction.query.filter_by(account_id=la.account_id, external_id=ext_id).first()
        if existing:
            if existing.status == "review":  # provider corrected it before it was categorised
                existing.date, existing.amount, existing.description = day, cents, (desc or existing.description)[:500]
            continue
        db.session.add(
            BankTransaction(account_id=la.account_id, linked_account_id=la.id, external_id=ext_id, date=day, description=(desc or "(no description)")[:500], amount=cents)
        )
        imported += 1
    for ext_id in removed:
        t = BankTransaction.query.filter_by(external_id=ext_id, status="review").first()
        if t is not None:
            db.session.delete(t)
    conn.status = "active"
    conn.last_synced_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()
    return imported


def sync_due(max_age_hours=None):
    """Sync every active connection that hasn't synced recently."""
    hours = max_age_hours if max_age_hours is not None else float(_setting("bank_sync_hours", "6") or 6)
    if hours <= 0:
        return 0
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
    total = 0
    for conn in BankConnection.query.filter(BankConnection.status.in_(("active", "error"))).all():
        if conn.last_synced_at and conn.last_synced_at > cutoff:
            continue
        try:
            total += sync_connection(conn)
        except ApiError as exc:
            log.warning("Bank sync failed for connection %s: %s", conn.id, exc.message)
    return total


def start_scheduler(app):
    """Background thread that runs sync_due() every 15 minutes (one per process)."""
    if app.config.get("TESTING") or os.environ.get("BANK_SYNC_DISABLED", "").lower() in ("1", "true", "yes"):
        return

    def loop():
        time.sleep(30)
        while True:
            try:
                with app.app_context():
                    n = sync_due()
                    if n:
                        log.info("Bank feeds: imported %s new transaction(s)", n)
            except Exception:  # noqa: BLE001 - keep the scheduler alive
                log.exception("Bank feed sync failed")
            time.sleep(15 * 60)

    threading.Thread(target=loop, name="bank-feed-sync", daemon=True).start()
