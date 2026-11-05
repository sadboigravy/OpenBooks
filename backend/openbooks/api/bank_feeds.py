"""Bank feeds API: connect banks, map their accounts, and sync transactions.

Provider credentials (Plaid, GoCardless) are the host's own, entered in
Settings → Bank connections or set with environment variables, which take
precedence: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, GOCARDLESS_SECRET_ID,
GOCARDLESS_SECRET_KEY. Secrets and bank access tokens are encrypted at rest and
never returned to the browser.
"""
import os
from datetime import date

from flask import g, jsonify, request

from .. import bank_feeds as feeds
from ..models import BANK_SUBTYPES, Account, BankConnection, BankTransaction, LinkedBankAccount, db
from ..util import ApiError, body, get_or_404, opt_str, parse_date
from . import bp, require_admin


def _mask(value):
    return ("•" * 8 + value[-4:]) if value else ""


@bp.get("/bank-feeds/config")
def bank_feeds_config():
    status = feeds.provider_status()
    out = {
        "providers": status,
        "sync_hours": float(feeds._setting("bank_sync_hours", "6") or 6),
        "connections": BankConnection.query.count(),
    }
    if g.user.role == "admin":
        out["settings"] = {
            "plaid_client_id": feeds.cfg("plaid_client_id"),
            "plaid_secret": _mask(feeds.cfg("plaid_secret")),
            "plaid_env": feeds.cfg("plaid_env") or "sandbox",
            "plaid_countries": feeds._setting("plaid_countries", "US"),
            "gocardless_secret_id": feeds.cfg("gocardless_secret_id"),
            "gocardless_secret_key": _mask(feeds.cfg("gocardless_secret_key")),
            "from_env": sorted(k for k, env in feeds.ENV.items() if os.environ.get(env)),
        }
    return jsonify(out)


@bp.put("/bank-feeds/config")
def update_bank_feeds_config():
    require_admin()
    data = body()
    for key in ("plaid_client_id", "gocardless_secret_id"):
        if key in data:
            feeds._set(key, opt_str(data, key))
    for key in feeds.SECRET_KEYS:
        if key in data:
            value = opt_str(data, key)
            if value.startswith("••"):
                continue  # unchanged mask sent back
            feeds._set(key, feeds.encrypt(value) if value else "")
    if "plaid_env" in data:
        env = opt_str(data, "plaid_env").lower() or "sandbox"
        if env not in feeds.PLAID_URLS:
            raise ApiError("Plaid environment must be sandbox or production")
        feeds._set("plaid_env", env)
    if "plaid_countries" in data:
        codes = [c.strip().upper() for c in opt_str(data, "plaid_countries").split(",") if c.strip()]
        if any(len(c) != 2 or not c.isalpha() for c in codes):
            raise ApiError("Plaid countries must be 2-letter codes separated by commas, e.g. US, CA, GB")
        feeds._set("plaid_countries", ",".join(codes) or "US")
    if "sync_hours" in data:
        try:
            hours = float(data["sync_hours"])
        except (TypeError, ValueError):
            raise ApiError("Sync interval must be a number of hours")
        if hours < 0 or hours > 168:
            raise ApiError("Sync interval must be between 0 (off) and 168 hours")
        feeds._set("bank_sync_hours", str(hours))
    db.session.commit()
    return bank_feeds_config()


@bp.get("/bank-feeds/connections")
def list_connections():
    conns = BankConnection.query.filter(BankConnection.status != "pending").order_by(BankConnection.id).all()
    return jsonify([c.to_dict() for c in conns])


@bp.post("/bank-feeds/connections")
def create_connection():
    require_admin()
    data = body()
    provider = opt_str(data, "provider")
    if provider == "simplefin":
        conn = feeds.simplefin_connect(opt_str(data, "setup_token"))
    elif provider == "plaid":
        token = opt_str(data, "public_token")
        if not token:
            raise ApiError("Plaid didn't return a token. Try connecting again.")
        conn = feeds.plaid_connect(token, opt_str(data, "institution"))
    else:
        raise ApiError("Choose SimpleFIN or Plaid (GoCardless connects through the bank's website)")
    db.session.commit()
    return jsonify(conn.to_dict()), 201


@bp.post("/bank-feeds/plaid/link-token")
def plaid_link_token():
    require_admin()
    return jsonify({"link_token": feeds.plaid_link_token(g.user.id)})


@bp.get("/bank-feeds/gocardless/institutions")
def gocardless_institutions():
    require_admin()
    return jsonify(feeds.gocardless_institutions(request.args.get("country", "")))


def _public_base():
    from .online_payments import cfg as stripe_cfg

    return (stripe_cfg("public_url") or request.host_url).rstrip("/")


@bp.post("/bank-feeds/gocardless/start")
def gocardless_start():
    require_admin()
    data = body()
    institution = opt_str(data, "institution_id")
    if not institution:
        raise ApiError("Choose your bank")
    conn, link = feeds.gocardless_start(institution, opt_str(data, "institution_name"), _public_base())
    db.session.commit()
    return jsonify({"connection_id": conn.id, "link": link})


@bp.post("/bank-feeds/connections/<int:conn_id>/finish")
def finish_connection(conn_id):
    require_admin()
    conn = get_or_404(BankConnection, conn_id, "Bank connection")
    if conn.provider != "gocardless":
        raise ApiError("Only GoCardless connections need finishing")
    if conn.status == "pending":
        feeds.gocardless_finish(conn)
        db.session.commit()
    return jsonify(conn.to_dict())


@bp.put("/bank-feeds/accounts/<int:linked_id>")
def map_linked_account(linked_id):
    require_admin()
    la = get_or_404(LinkedBankAccount, linked_id, "Linked account")
    data = body()
    if "account_id" in data:
        if data["account_id"] in (None, "", 0):
            la.account_id = None
        else:
            account = db.session.get(Account, int(data["account_id"]))
            if account is None or account.subtype not in BANK_SUBTYPES:
                raise ApiError("Choose a bank, cash or credit card account")
            clash = LinkedBankAccount.query.filter(LinkedBankAccount.account_id == account.id, LinkedBankAccount.id != la.id, LinkedBankAccount.active.is_(True)).first()
            if clash:
                raise ApiError(f"{account.label} is already linked to {clash.name}. Unlink it there first.")
            la.account_id = account.id
    if "sync_from" in data:
        la.sync_from = parse_date(data["sync_from"], "start date", required=False) or date.today()
    if "active" in data:
        la.active = bool(data["active"])
    db.session.commit()
    return jsonify(la.to_dict())


@bp.post("/bank-feeds/connections/<int:conn_id>/sync")
def sync_connection(conn_id):
    conn = get_or_404(BankConnection, conn_id, "Bank connection")
    if conn.status == "pending":
        raise ApiError("Finish connecting this bank first")
    imported = feeds.sync_connection(conn)
    return jsonify({"imported": imported, "connection": db.session.get(BankConnection, conn_id).to_dict()})


@bp.post("/bank-feeds/sync")
def sync_all():
    total, errors = 0, []
    for conn in BankConnection.query.filter(BankConnection.status.in_(("active", "error"))).all():
        try:
            total += feeds.sync_connection(conn)
        except ApiError as exc:
            errors.append(f"{conn.institution}: {exc.message}")
    return jsonify({"imported": total, "errors": errors})


@bp.delete("/bank-feeds/connections/<int:conn_id>")
def delete_connection(conn_id):
    require_admin()
    conn = get_or_404(BankConnection, conn_id, "Bank connection")
    if conn.provider == "plaid" and conn.secret:
        try:  # tell Plaid to stop billing for / accessing this item
            feeds._plaid("/item/remove", {"access_token": feeds._secret(conn)["access_token"]})
        except ApiError:
            pass
    ids = [la.id for la in conn.accounts]
    if ids:
        # keep imported transactions; just detach them from the connection
        BankTransaction.query.filter(BankTransaction.linked_account_id.in_(ids)).update({"linked_account_id": None}, synchronize_session=False)
    db.session.delete(conn)
    db.session.commit()
    return "", 204
