"""Optional AI assistant powered by Claude.

Bring your own key: each OpenBooks instance connects its own Anthropic account,
either in Settings → AI assistant (stored in the database) or with the
ANTHROPIC_API_KEY environment variable, which takes precedence. Nothing is sent
to Anthropic until an administrator turns the assistant on.

The assistant can only *read* the books. Each tool runs one of OpenBooks' own
GET endpoints as the signed-in user, so it sees exactly what that user can see
and cannot create, change or delete anything.
"""
import json
import logging
import os
from datetime import date

import anthropic
from flask import current_app, g, jsonify

from ..models import Setting, db
from ..util import ApiError, body
from . import bp, require_admin

log = logging.getLogger("openbooks.assistant")

MODELS = {
    "claude-opus-5-5": "Claude Opus 5.5 — most capable (default)",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 — fast and capable",
    "claude-haiku-5-5": "Claude Haiku 5.5 — fastest, lowest cost",
}
DEFAULT_MODEL = "claude-opus-5-5"
EFFORTS = ("low", "medium", "high")
# Models that accept the server-side refusal fallback ("default" routing)
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
MAX_TOOL_ROUNDS = 8
MAX_TOOL_RESULT_CHARS = 60_000


# ---------------------------------------------------------------- configuration


def _stored(key):
    row = db.session.get(Setting, key)
    return row.value.strip() if row else ""


def _set(key, value):
    row = db.session.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        db.session.add(row)
    row.value = value


def api_key():
    return os.environ.get("ANTHROPIC_API_KEY", "").strip() or _stored("ai_api_key")


def model():
    m = _stored("ai_model")
    return m if m in MODELS else DEFAULT_MODEL


def effort():
    e = _stored("ai_effort")
    return e if e in EFFORTS else "medium"


def assistant_ready():
    return _stored("ai_enabled") == "true" and bool(api_key())


def _mask(value):
    return f"{value[:10]}…{value[-4:]}" if value and len(value) > 16 else ("••••" if value else None)


@bp.get("/assistant/config")
def get_assistant_config():
    require_admin()
    return jsonify(
        {
            "enabled": _stored("ai_enabled") == "true",
            "ready": assistant_ready(),
            "api_key_saved": _mask(api_key()),
            "api_key_from_environment": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "model": model(),
            "models": MODELS,
            "effort": effort(),
        }
    )


@bp.put("/assistant/config")
def update_assistant_config():
    require_admin()
    data = body()
    if data.get("api_key"):
        key = str(data["api_key"]).strip()
        if not key.startswith("sk-ant-"):
            raise ApiError("An Anthropic API key starts with sk-ant-")
        _set("ai_api_key", key)
    if "clear_api_key" in data and data["clear_api_key"]:
        _set("ai_api_key", "")
        _set("ai_enabled", "false")
    if "model" in data:
        if data["model"] not in MODELS:
            raise ApiError("Unknown model")
        _set("ai_model", data["model"])
    if "effort" in data:
        if data["effort"] not in EFFORTS:
            raise ApiError("Effort must be low, medium or high")
        _set("ai_effort", data["effort"])
    if "enabled" in data:
        if data["enabled"] and not api_key():
            raise ApiError("Add an Anthropic API key before turning the assistant on")
        _set("ai_enabled", "true" if data["enabled"] else "false")
    db.session.commit()
    return get_assistant_config()


@bp.post("/assistant/test")
def test_assistant():
    require_admin()
    try:
        client().messages.create(model=model(), max_tokens=16, messages=[{"role": "user", "content": "Reply with OK."}])
    except anthropic.AuthenticationError:
        raise ApiError("Anthropic rejected the API key. Check that you copied it correctly.")
    except anthropic.APIConnectionError:
        raise ApiError("Could not reach the Anthropic API from this server. Check its internet access.")
    except anthropic.APIStatusError as exc:
        raise ApiError(f"Anthropic API error ({exc.status_code}): {exc.message}")
    return jsonify({"ok": True, "model": model()})


def client():
    key = api_key()
    if not key:
        raise ApiError("The AI assistant is not set up. An administrator can add an Anthropic API key in Settings → AI assistant.")
    return anthropic.Anthropic(api_key=key, timeout=120.0, max_retries=2)


# ---------------------------------------------------------------- read-only tools


def _schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


DATE = {"type": "string", "description": "Date in YYYY-MM-DD format"}

# name -> (description, input schema, endpoint path, allowed query params)
TOOLS = {
    "get_dashboard": ("Headline numbers: cash, receivables, payables, credit cards, income/expenses/net this month and fiscal year to date, 12-month trend, overdue invoices, upcoming bills.", _schema(), "/dashboard", ()),
    "get_profit_and_loss": ("Profit and loss (income statement) for a date range, broken down by account. Defaults to the current fiscal year to date.", _schema({"start": DATE, "end": DATE}), "/reports/profit-loss", ("start", "end")),
    "get_balance_sheet": ("Balance sheet (assets, liabilities, equity) as of a date. Defaults to today.", _schema({"as_of": DATE}), "/reports/balance-sheet", ("as_of",)),
    "get_trial_balance": ("Debit and credit balance of every account as of a date.", _schema({"as_of": DATE}), "/reports/trial-balance", ("as_of",)),
    "get_ar_aging": ("Unpaid customer invoices grouped by customer and how many days overdue they are.", _schema({"as_of": DATE}), "/reports/ar-aging", ("as_of",)),
    "get_ap_aging": ("Unpaid vendor bills grouped by vendor and how many days overdue they are.", _schema({"as_of": DATE}), "/reports/ap-aging", ("as_of",)),
    "get_general_ledger": (
        "Every ledger line for one account (or all accounts) in a date range, with running balances. Use list_accounts first to find an account_id.",
        _schema({"account_id": {"type": "integer"}, "start": DATE, "end": DATE}),
        "/reports/general-ledger",
        ("account_id", "start", "end"),
    ),
    "list_accounts": ("The chart of accounts with each account's id, number, name, type and current balance.", _schema(), "/accounts", ()),
    "list_invoices": (
        "Sales documents. kind: invoice (default), estimate, sales_receipt or all. status filter for invoices: unpaid, overdue, paid, draft, void.",
        _schema({"kind": {"type": "string", "enum": ["invoice", "estimate", "sales_receipt", "all"]}, "status": {"type": "string"}, "customer_id": {"type": "integer"}}),
        "/invoices",
        ("kind", "status", "customer_id"),
    ),
    "get_invoice": ("Full detail of one invoice, estimate or sales receipt, including lines and payments.", _schema({"id": {"type": "integer"}}, ["id"]), "/invoices/{id}", ()),
    "list_bills": ("Vendor bills. status filter: unpaid, overdue, paid.", _schema({"status": {"type": "string"}, "vendor_id": {"type": "integer"}}), "/bills", ("status", "vendor_id")),
    "list_expense_transactions": ("All purchase transactions: expenses, checks, bills and bill payments, newest first.", _schema({"vendor_id": {"type": "integer"}}), "/purchases/transactions", ("vendor_id",)),
    "list_customers": ("Customers with contact details and open/overdue balances. Optional search text q.", _schema({"q": {"type": "string"}}), "/customers", ("q",)),
    "list_vendors": ("Vendors with contact details and open/overdue balances. Optional search text q.", _schema({"q": {"type": "string"}}), "/vendors", ("q",)),
    "list_journal_entries": (
        "Ledger entries newest first, optionally filtered by date range and source (manual, invoice, invoice_payment, bill, bill_payment, expense, bank, deposit, transfer, payroll).",
        _schema({"start": DATE, "end": DATE, "source": {"type": "string"}, "limit": {"type": "integer"}}),
        "/journal-entries",
        ("start", "end", "source", "limit"),
    ),
    "list_bank_accounts": ("Bank, cash and credit card accounts with balances and how many bank-feed lines await review.", _schema(), "/bank/accounts", ()),
    "list_products_and_services": ("Products and services with prices and income accounts.", _schema(), "/items", ()),
    "search": ("Search customers, vendors, invoices, bills, products, employees and accounts by text.", _schema({"q": {"type": "string"}}, ["q"]), "/search", ("q",)),
    "get_sales_tax_liability": (
        "Sales tax / VAT / GST collected, input tax on purchases, payments and balance owed per tax agency for a date range.",
        _schema({"start": DATE, "end": DATE}),
        "/tax/liability",
        ("start", "end"),
    ),
    "get_sales_tax_overview": ("Each tax agency's filing frequency, balance owed and recent filing periods with amounts due.", _schema(), "/tax/overview", ()),
    "get_income_tax_summary": (
        "Year-end business income tax summary: income and deductions grouped by the lines of the company's tax return (e.g. Schedule C), with unmapped accounts.",
        _schema({"year": {"type": "integer"}}),
        "/income-tax/summary",
        ("year",),
    ),
    "get_payroll_summary": ("Payroll runs (gross, net, employer taxes) newest first.", _schema(), "/payroll/runs", ()),
    "list_employees": ("Employees with pay type, rate and schedule.", _schema(), "/employees", ()),
}


def tool_definitions():
    return [{"name": name, "description": desc, "input_schema": schema} for name, (desc, schema, _, _) in TOOLS.items()]


def run_tool(name, args):
    """Run a read-only tool by calling the matching GET endpoint as the current user."""
    if name not in TOOLS:
        return f"Unknown tool {name}", True
    _, _, path, allowed = TOOLS[name]
    args = args if isinstance(args, dict) else {}
    if "{id}" in path:
        if not str(args.get("id", "")).isdigit():
            return "An integer id is required", True
        path = path.replace("{id}", str(args["id"]))
    query = {k: str(v) for k, v in args.items() if k in allowed and v not in (None, "")}
    app = current_app._get_current_object()
    adapter = app.url_map.bind("localhost")
    try:
        endpoint, view_args = adapter.match(f"/api{path}", method="GET")
        view_rule = app.view_functions[endpoint]
    except Exception:  # noqa: BLE001 - routing failure becomes a tool error
        return f"No data source for {name}", True
    user = g.user
    with app.test_request_context(f"/api{path}", method="GET", query_string=query):
        g.user = user
        try:
            response = view_rule(**view_args)
        except ApiError as exc:
            return exc.message, True
        payload = response.get_json() if hasattr(response, "get_json") else response
    text = json.dumps(payload, separators=(",", ":"), default=str)
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = text[:MAX_TOOL_RESULT_CHARS] + '… [truncated: ask for a narrower date range or filter]'
    return text, False


# ---------------------------------------------------------------- chat


def _system_prompt():
    from .settings import get_settings

    s = get_settings()
    return (
        f"You are the bookkeeping assistant inside OpenBooks, a double-entry accounting app, for the company "
        f"\"{s.get('company_name')}\". Amounts are in {s.get('currency', 'USD')}. Today is {date.today().isoformat()}. "
        f"The fiscal year starts in month {s.get('fiscal_year_start_month', '1')}.\n\n"
        "Answer questions about this company's books using the tools, which read live data. Always look the numbers up "
        "rather than guessing, and say which report or period a figure comes from. You can only read data: if the user asks "
        "you to create, edit, pay or delete something, explain where in OpenBooks to do it (for example, the + New menu → "
        "Invoice, or Sales → Invoices → Receive payment) instead.\n\n"
        "Write for a busy small-business owner: lead with the answer, keep it short, use plain language, format money "
        "with the currency symbol and thousands separators, and use short bullet lists or a small markdown table when "
        "comparing several items. If something in the data looks unusual (overdue balances, negative cash, unbalanced "
        "reports), point it out briefly. You are not a licensed accountant or tax adviser; for tax or legal decisions, "
        "suggest confirming with one."
    )


def _clean_history(messages):
    """Accept only plain user/assistant text turns from the browser."""
    clean = []
    for m in messages[-20:]:
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            clean.append({"role": role, "content": content[:8000]})
    while clean and clean[0]["role"] != "user":
        clean.pop(0)
    if not clean or clean[-1]["role"] != "user":
        raise ApiError("Ask a question first")
    return clean


@bp.post("/assistant/chat")
def assistant_chat():
    if not assistant_ready():
        raise ApiError("The AI assistant is not turned on. An administrator can set it up in Settings → AI assistant.", 400)
    messages = _clean_history(body().get("messages") or [])
    c = client()
    chosen = model()
    request_args = {
        "model": chosen,
        "max_tokens": 16000,
        "system": _system_prompt(),
        "tools": tool_definitions(),
        "output_config": {"effort": effort()},
    }
    if chosen in FALLBACK_MODELS:
        # If a safety classifier declines, retry automatically on another model
        request_args.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    used_tools = []
    try:
        for _ in range(MAX_TOOL_ROUNDS):
            response = c.beta.messages.create(messages=messages, **request_args)
            if response.stop_reason == "refusal":
                return jsonify({"reply": "Sorry, I can't help with that request.", "tools": used_tools})
            # Append the full assistant turn unchanged (keeps thinking/tool blocks valid)
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason == "pause_turn":
                continue
            calls = [b for b in response.content if b.type == "tool_use"]
            if response.stop_reason != "tool_use" or not calls:
                text = "\n\n".join(b.text for b in response.content if b.type == "text").strip()
                if response.stop_reason == "max_tokens":
                    text += "\n\n_(The answer was cut short. Try a narrower question.)_"
                return jsonify({"reply": text or "I couldn't find an answer to that.", "tools": used_tools, "model": response.model})
            results = []
            for call in calls:
                used_tools.append(call.name)
                content, is_error = run_tool(call.name, call.input)
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": content, "is_error": is_error})
            messages.append({"role": "user", "content": results})
    except anthropic.AuthenticationError:
        raise ApiError("The Anthropic API key was rejected. An administrator can update it in Settings → AI assistant.", 502)
    except anthropic.RateLimitError:
        raise ApiError("The AI assistant is busy (rate limited). Try again in a minute.", 429)
    except anthropic.APIConnectionError:
        raise ApiError("Could not reach the Anthropic API from this server.", 502)
    except anthropic.APIStatusError as exc:
        log.warning("Anthropic API error %s: %s", exc.status_code, exc.message)
        raise ApiError(f"The AI assistant hit an error ({exc.status_code}). Try again.", 502)
    return jsonify({"reply": "That needed more lookups than I'm allowed in one answer. Try a more specific question.", "tools": used_tools})
