import pytest
from werkzeug.security import generate_password_hash

from openbooks import create_app

GOOD = {"name": "Gavin", "email": "owner@example.com", "password": "correct horse battery", "confirm": "correct horse battery"}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_EMAIL", raising=False)
    monkeypatch.delenv("DEMO_DATA", raising=False)
    return create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})


def _login(c, email="admin@openbooks.local", password="openbooks"):
    return c.post("/api/auth/login", json={"email": email, "password": password})


def test_default_login_can_only_create_an_admin(app):
    c = app.test_client()
    me = _login(c).json
    assert me["setup_required"] is True
    assert c.get("/api/auth/me").json["setup_required"] is True
    # everything else is blocked
    assert c.get("/api/accounts").status_code == 403
    assert c.get("/api/users").status_code == 403
    assert c.post("/api/customers", json={"name": "x"}).status_code == 403


def test_setup_validation(app):
    c = app.test_client()
    _login(c)
    assert c.post("/api/auth/setup-admin", json={**GOOD, "email": "admin@openbooks.local"}).status_code == 400
    assert c.post("/api/auth/setup-admin", json={**GOOD, "password": "short", "confirm": "short"}).status_code == 400
    assert c.post("/api/auth/setup-admin", json={**GOOD, "password": "openbooks", "confirm": "openbooks"}).status_code == 400
    assert c.post("/api/auth/setup-admin", json={**GOOD, "confirm": "different password"}).status_code == 400
    assert c.post("/api/auth/setup-admin", json={**GOOD, "name": ""}).status_code == 400


def test_setup_replaces_and_removes_default_login(app):
    c = app.test_client()
    # the login page shows the first-run hint only while the default login exists
    assert app.test_client().get("/api/auth/status").json == {"first_run": True}
    _login(c)
    r = c.post("/api/auth/setup-admin", json=GOOD)
    assert r.status_code == 201, r.json
    assert app.test_client().get("/api/auth/status").json == {"first_run": False}
    assert r.json["email"] == "owner@example.com" and r.json["role"] == "admin" and r.json["setup_required"] is False
    # signed in as the new admin, with full access
    assert c.get("/api/auth/me").json["email"] == "owner@example.com"
    assert c.get("/api/accounts").status_code == 200
    users = c.get("/api/users").json
    assert [u["email"] for u in users] == ["owner@example.com"]
    # the default login no longer exists
    fresh = app.test_client()
    assert _login(fresh).status_code == 401
    assert _login(fresh, "owner@example.com", "correct horse battery").status_code == 200
    # and setup cannot be repeated
    assert c.post("/api/auth/setup-admin", json=GOOD).status_code == 400


def test_default_login_not_recreated_on_restart(app, tmp_path):
    c = app.test_client()
    _login(c)
    c.post("/api/auth/setup-admin", json=GOOD)
    app2 = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    assert _login(app2.test_client()).status_code == 401


def test_existing_install_still_on_default_password_is_flagged(app, tmp_path):
    from openbooks.models import User, db

    with app.app_context():
        u = User.query.first()
        u.is_bootstrap = False  # an install from before this feature
        db.session.commit()
    app2 = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    assert _login(app2.test_client()).json["setup_required"] is True


def test_custom_env_credentials_are_not_forced_through_setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "boss@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "a-strong-chosen-password")
    monkeypatch.delenv("DEMO_DATA", raising=False)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True})
    c = app.test_client()
    assert _login(c, "boss@example.com", "a-strong-chosen-password").json["setup_required"] is False
    assert c.get("/api/accounts").status_code == 200
