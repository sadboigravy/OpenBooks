from types import SimpleNamespace as NS

import pytest

from openbooks import create_app
from openbooks.api import assistant


def _text(t):
    return NS(type="text", text=t)


def _tool(id_, name, inp):
    return NS(type="tool_use", id=id_, name=name, input=inp)


class FakeMessages:
    """Scripted Claude: first asks for the P&L tool, then answers using the tool result."""

    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        msgs = kwargs["messages"]
        last = msgs[-1]
        if isinstance(last["content"], list) and last["content"] and last["content"][0].get("type") == "tool_result":
            data = last["content"][0]["content"]
            return NS(stop_reason="end_turn", model=kwargs["model"], content=[_text(f"Net income is in here: {data[:40]}")])
        return NS(stop_reason="tool_use", model=kwargs["model"], content=[_text("Let me check."), _tool("tu_1", "get_profit_and_loss", {"start": "2026-01-01"})])


class FakeClient:
    def __init__(self):
        self.beta = NS(messages=FakeMessages())
        self.messages = NS(create=lambda **k: NS(content=[_text("OK")]))


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEMO_DATA", raising=False)
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    fake = FakeClient()
    monkeypatch.setattr(assistant, "client", lambda: fake)
    app = create_app({"DATA_DIR": str(tmp_path), "TESTING": True, "STATIC_DIR": str(tmp_path / "dist")})
    c = app.test_client()
    c.post("/api/auth/login", json={"email": "admin@openbooks.local", "password": "password123"})
    return app, c, fake


def test_off_until_admin_connects_key(env):
    _, c, _ = env
    assert c.get("/api/settings").json["assistant_enabled"] is False
    assert c.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "hi"}]}).status_code == 400
    assert c.put("/api/assistant/config", json={"enabled": True}).status_code == 400
    assert c.put("/api/assistant/config", json={"api_key": "not-a-key"}).status_code == 400
    cfg = c.put("/api/assistant/config", json={"api_key": "sk-ant-api03-abcdefghijklmnop", "enabled": True, "model": "claude-sonnet-5-5"}).json
    assert cfg["ready"] and cfg["model"] == "claude-sonnet-5-5"
    assert "abcdefghijklmnop" not in str(cfg) and "abcdefghijklmnop" not in str(c.get("/api/settings").json)


def test_env_key_takes_precedence(env, monkeypatch):
    _, c, _ = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-fromenvironment000")
    assert c.get("/api/assistant/config").json["api_key_from_environment"] is True


def test_chat_runs_read_only_tools_against_live_books(env):
    _, c, fake = env
    c.put("/api/assistant/config", json={"api_key": "sk-ant-api03-abcdefghijklmnop", "enabled": True})
    r = c.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "How did we do this year?"}]})
    assert r.status_code == 200, r.json
    assert r.json["tools"] == ["get_profit_and_loss"]
    assert '"gross_profit"' in r.json["reply"]
    first = fake.beta.messages.calls[0]
    assert first["model"] == "claude-opus-5-5"
    assert first["fallbacks"] == "default"
    assert "tool_choice" not in first
    tool_names = {t["name"] for t in first["tools"]}
    assert not any(n.startswith(("create", "update", "delete", "pay")) for n in tool_names)


def test_tools_respect_permissions_and_only_read(env):
    app, c, _ = env
    with app.test_request_context():
        from flask import g

        from openbooks.models import User

        g.user = User.query.first()
        text, err = assistant.run_tool("get_balance_sheet", {"as_of": "2026-01-01"})
        assert not err and "Balance Sheet" in text
        text, err = assistant.run_tool("drop_tables", {})
        assert err
        # every tool maps to a GET route
        for name, (_, _, path, _) in assistant.TOOLS.items():
            app.url_map.bind("localhost").match("/api" + path.replace("{id}", "1"), method="GET")
