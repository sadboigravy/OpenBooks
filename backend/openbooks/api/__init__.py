from flask import Blueprint, g, request, session

from ..models import User, db
from ..util import ApiError

bp = Blueprint("api", __name__)

# The only endpoints the built-in first-run login may use
SETUP_ENDPOINTS = {"api.me", "api.logout", "api.setup_admin"}

PUBLIC_ENDPOINTS = {
    "api.login",
    "api.me",
    "api.auth_status",
    # customer-facing "pay online" page and Stripe's server-to-server webhook
    "api.public_invoice",
    "api.public_checkout",
    "api.public_confirm",
    "api.stripe_webhook",
}
# Endpoints any signed-in user (including read-only viewers) may call with POST
SELF_SERVICE_ENDPOINTS = {"api.logout", "api.change_password"}
# POST endpoints that only calculate (nothing is saved), so read-only viewers may use them
READ_ONLY_POST_ENDPOINTS = {"api.tax_preview", "api.payroll_preview"}


@bp.before_request
def require_login():
    g.user = None
    user_id = session.get("user_id")
    if user_id:
        user = db.session.get(User, user_id)
        if user and user.active:
            g.user = user
        else:
            session.clear()

    if request.endpoint in PUBLIC_ENDPOINTS:
        return
    if g.user is None:
        raise ApiError("Please sign in", 401)
    if g.user.is_bootstrap and request.endpoint not in SETUP_ENDPOINTS:
        raise ApiError("Create your administrator account to finish setting up OpenBooks", 403)

    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        # Browsers cannot send a cross-site JSON POST without a CORS preflight,
        # so requiring JSON bodies protects against CSRF.
        if request.method in ("POST", "PUT", "PATCH") and not request.is_json:
            raise ApiError("Requests must be sent as JSON", 415)
        if request.endpoint not in SELF_SERVICE_ENDPOINTS | READ_ONLY_POST_ENDPOINTS and g.user.role == "viewer":
            raise ApiError("Your account has read-only access", 403)


def require_admin():
    if g.user is None or g.user.role != "admin":
        raise ApiError("Only administrators can do this", 403)


# Register route modules
from . import accounts, assistant, auth, bank_feeds, income_tax, banking, contacts, dashboard, online_payments, payroll, payroll_taxes, purchases, reports, sales, search, settings, taxes, users  # noqa: E402,F401
