"""Run OpenBooks with stand-in bank-data providers, for the bank-feeds browser test.

Usage: python fake_provider_server.py <data_dir> <port>

The real SimpleFIN / Plaid / GoCardless services can't be used in tests, so every outgoing
provider request is answered here with canned data. Needs the backend's Python packages
installed and the web UI built (frontend/dist).
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from openbooks import bank_feeds, create_app  # noqa: E402


def _epoch(d):
    return int(datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc).timestamp()) + 3600


TODAY = date.today()


def fake_http(method, url, json_body=None, headers=None, form=None):
    if "/claim/" in url:  # SimpleFIN: setup token -> access URL
        return 200, "https://user:pass@bridge.example/sf"
    if "/sf/accounts" in url:
        txs = [] if "balances-only" in url else [
            {"id": "t1", "posted": _epoch(TODAY - timedelta(days=2)), "amount": "-42.50", "payee": "Coffee Co", "description": "POS 123"},
            {"id": "t2", "posted": _epoch(TODAY - timedelta(days=1)), "amount": "1200.00", "description": "Client payment ACME"},
        ]
        return 200, {"errors": [], "accounts": [
            {"id": "a1", "name": "Business Checking", "currency": "USD", "balance": "5000.25", "org": {"name": "First Community Bank"}, "transactions": txs},
            {"id": "a2", "name": "Visa Rewards", "currency": "USD", "balance": "-310.00", "org": {"name": "First Community Bank"}, "transactions": []},
        ]}
    if "/token/new/" in url:  # GoCardless
        return 200, {"access": "test-token"}
    if "/institutions/" in url:
        return 200, [{"id": "MONZO", "name": "Monzo", "logo": ""}, {"id": "BARC", "name": "Barclays", "logo": ""}]
    raise RuntimeError("unexpected provider call: " + url)


if __name__ == "__main__":
    data_dir, port = sys.argv[1], int(sys.argv[2])
    bank_feeds._http = fake_http
    app = create_app({"DATA_DIR": data_dir, "STATIC_DIR": os.path.join(ROOT, "frontend", "dist"), "TESTING": True})
    app.run(host="127.0.0.1", port=port, threaded=True)
