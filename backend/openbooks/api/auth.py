from flask import g, jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

from ..models import User, db
from ..util import ApiError, body
from . import bp


@bp.post("/auth/login")
def login():
    data = body()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    user = User.query.filter_by(email=email).first()
    if not user or not check_password_hash(user.password_hash, password):
        raise ApiError("Incorrect email or password", 401)
    if not user.active:
        raise ApiError("This account has been disabled", 403)
    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    return jsonify(user.to_dict())


@bp.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.get("/auth/status")
def auth_status():
    """Public: whether the built-in first-run login still exists (the login page shows a hint only then)."""
    return jsonify({"first_run": User.query.filter_by(is_bootstrap=True, active=True).first() is not None})


@bp.get("/auth/me")
def me():
    # Returns null (not 401) when signed out so the UI can check quietly on load
    return jsonify(g.user.to_dict() if g.user else None)


@bp.post("/auth/change-password")
def change_password():
    data = body()
    if not check_password_hash(g.user.password_hash, str(data.get("current_password") or "")):
        raise ApiError("Your current password is incorrect")
    new = str(data.get("new_password") or "")
    if len(new) < 8:
        raise ApiError("The new password must be at least 8 characters")
    g.user.password_hash = generate_password_hash(new)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/auth/setup-admin")
def setup_admin():
    """Replace the built-in first-run login with a real administrator account."""
    from ..models import Setting
    from ..seed import DEFAULT_ADMIN_PASSWORD

    if g.user is None or not g.user.is_bootstrap:
        raise ApiError("Setup has already been completed", 400)
    data = body()
    name = str(data.get("name") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    if not name:
        raise ApiError("Enter your name")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ApiError("Enter a valid email address")
    if email == g.user.email:
        raise ApiError("Use your own email address, not the default one")
    if User.query.filter(User.email == email, User.id != g.user.id).first():
        raise ApiError("A user with that email already exists")
    if len(password) < 10:
        raise ApiError("The password must be at least 10 characters")
    if password.lower() in (DEFAULT_ADMIN_PASSWORD, "password", "password123", "openbooks123") or password.lower() == email:
        raise ApiError("Choose a less guessable password")
    if password != str(data.get("confirm") or ""):
        raise ApiError("The passwords do not match")

    admin = User(email=email, name=name, role="admin", password_hash=generate_password_hash(password))
    db.session.add(admin)
    db.session.flush()
    # remove the default login completely so it can never be used again
    db.session.delete(g.user)
    row = db.session.get(Setting, "admin_setup_complete") or Setting(key="admin_setup_complete")
    row.value = "true"
    db.session.add(row)
    db.session.commit()
    session.clear()
    session.permanent = True
    session["user_id"] = admin.id
    return jsonify(admin.to_dict()), 201
