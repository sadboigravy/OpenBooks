"""OpenBooks: small-business double-entry accounting."""
import os
import secrets

from flask import Flask, jsonify, send_from_directory
from werkzeug.exceptions import HTTPException

from .models import db
from .util import ApiError


def _secret_key(data_dir):
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    # Persist a generated key so logins survive container restarts
    path = os.path.join(data_dir, "secret_key")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    os.chmod(path, 0o600)
    return key


def create_app(config=None):
    config = config or {}
    static_dir = config.get("STATIC_DIR") or os.environ.get(
        "STATIC_DIR",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")),
    )
    data_dir = config.get("DATA_DIR") or os.environ.get("DATA_DIR") or os.path.abspath("data")
    os.makedirs(data_dir, exist_ok=True)

    app = Flask(__name__, static_folder=None)
    app.config.update(
        SQLALCHEMY_DATABASE_URI=os.environ.get(
            "DATABASE_URL", "sqlite:///" + os.path.join(data_dir, "openbooks.db")
        ),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SECRET_KEY=_secret_key(data_dir),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "").lower() == "true",
        PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 14,
        STATIC_DIR=static_dir,
    )
    app.config.update(config)

    db.init_app(app)

    from .api import bp as api_bp

    app.register_blueprint(api_bp, url_prefix="/api")

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({"error": err.message}), err.status

    @app.errorhandler(HTTPException)
    def handle_http_error(err):
        from flask import request

        if request.path.startswith("/api/"):
            return jsonify({"error": err.description}), err.code
        return err

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    # Serve the compiled React app; unknown paths go to index.html (client-side routing)
    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path):  # noqa: C901
        if path.startswith("api/"):
            return jsonify({"error": "Not found"}), 404
        root = app.config["STATIC_DIR"]
        if path and os.path.isfile(os.path.join(root, path)):
            return send_from_directory(root, path)
        if os.path.isfile(os.path.join(root, "index.html")):
            response = send_from_directory(root, "index.html")
            response.headers["Cache-Control"] = "no-cache"
            return response
        return (
            "<h1>OpenBooks API is running</h1><p>The web UI has not been built. "
            "Run <code>npm run build</code> in <code>frontend/</code> or rebuild the Docker image.</p>",
            503,
        )

    with app.app_context():
        db.create_all()
        _upgrade_schema()
        from .seed import ensure_defaults

        ensure_defaults()

    from .bank_feeds import start_scheduler

    start_scheduler(app)
    return app


def _upgrade_schema():
    """Add columns introduced by newer versions to an existing database.

    ``create_all`` creates missing tables but never alters existing ones, so
    without this an upgraded install would crash on new columns.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    for table in db.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        existing = {c["name"] for c in inspector.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(db.engine.dialect)}'
            default = col.default.arg if col.default is not None and col.default.is_scalar else None
            if isinstance(default, bool):
                ddl += f" DEFAULT {1 if default else 0}"
            elif isinstance(default, (int, float)):
                ddl += f" DEFAULT {default}"
            elif isinstance(default, str):
                ddl += " DEFAULT '" + default.replace("'", "''") + "'"
            db.session.execute(text(ddl))
    db.session.commit()
