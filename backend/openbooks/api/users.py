from flask import g, jsonify
from werkzeug.security import generate_password_hash

from ..models import ROLES, User, db
from ..util import ApiError, body, get_or_404, required_str
from . import bp, require_admin


def _active_admins(exclude_id=None):
    q = User.query.filter_by(role="admin", active=True)
    if exclude_id:
        q = q.filter(User.id != exclude_id)
    return q.count()


@bp.get("/users")
def list_users():
    require_admin()
    return jsonify([u.to_dict() for u in User.query.order_by(User.name).all()])


@bp.post("/users")
def create_user():
    require_admin()
    data = body()
    email = required_str(data, "email").lower()
    if "@" not in email:
        raise ApiError("Enter a valid email address")
    if User.query.filter_by(email=email).first():
        raise ApiError("A user with that email already exists")
    password = str(data.get("password") or "")
    if len(password) < 8:
        raise ApiError("Password must be at least 8 characters")
    role = data.get("role") or "accountant"
    if role not in ROLES:
        raise ApiError("Invalid role")
    user = User(
        email=email,
        name=required_str(data, "name"),
        role=role,
        password_hash=generate_password_hash(password),
    )
    db.session.add(user)
    db.session.commit()
    return jsonify(user.to_dict()), 201


@bp.put("/users/<int:user_id>")
def update_user(user_id):
    require_admin()
    user = get_or_404(User, user_id, "User")
    data = body()
    if "name" in data:
        user.name = required_str(data, "name")
    if "email" in data:
        email = required_str(data, "email").lower()
        if User.query.filter(User.email == email, User.id != user.id).first():
            raise ApiError("A user with that email already exists")
        user.email = email
    if "role" in data:
        if data["role"] not in ROLES:
            raise ApiError("Invalid role")
        if user.role == "admin" and data["role"] != "admin" and _active_admins(user.id) == 0:
            raise ApiError("There must be at least one active administrator")
        user.role = data["role"]
    if "active" in data:
        active = bool(data["active"])
        if not active and user.id == g.user.id:
            raise ApiError("You cannot disable your own account")
        if not active and user.role == "admin" and _active_admins(user.id) == 0:
            raise ApiError("There must be at least one active administrator")
        user.active = active
    if data.get("password"):
        if len(data["password"]) < 8:
            raise ApiError("Password must be at least 8 characters")
        user.password_hash = generate_password_hash(data["password"])
    db.session.commit()
    return jsonify(user.to_dict())
