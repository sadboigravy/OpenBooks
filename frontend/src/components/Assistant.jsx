// "Ask Claude" side panel: a read-only bookkeeping assistant.
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post, useApp } from '../lib.jsx';

const SUGGESTIONS = [
  'How much do customers owe me, and who is most overdue?',
  'What were my biggest expenses in the last 3 months?',
  'How does this year’s profit compare with last year?',
  'Which bills are due in the next two weeks?',
];

const TOOL_LABELS = {
  get_dashboard: 'dashboard',
  get_profit_and_loss: 'profit & loss',
  get_balance_sheet: 'balance sheet',
  get_trial_balance: 'trial balance',
  get_ar_aging: 'receivables aging',
  get_ap_aging: 'payables aging',
  get_general_ledger: 'general ledger',
  list_accounts: 'chart of accounts',
  list_invoices: 'invoices',
  get_invoice: 'an invoice',
  list_bills: 'bills',
  list_expense_transactions: 'expenses',
  list_customers: 'customers',
  list_vendors: 'vendors',
  list_journal_entries: 'journal',
  list_bank_accounts: 'bank accounts',
  list_products_and_services: 'products & services',
  search: 'search',
  get_payroll_summary: 'payroll',
  list_employees: 'employees',
};

/** Minimal, safe markdown: paragraphs, bullet/numbered lists, **bold**, `code`, and simple tables. */
function inline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    if (p.startsWith('_') && p.endsWith('_') && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function Markdown({ text }) {
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block, bi) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return null;
    if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|'))) {
      const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      return (
        <table key={bi} className="md-table">
          <thead>
            <tr>
              {rows[0].map((c, i) => (
                <th key={i}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((r, ri) => (
              <tr key={ri}>
                {r.map((c, i) => (
                  <td key={i}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      const List = ordered ? 'ol' : 'ul';
      return (
        <List key={bi}>
          {lines.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>
          ))}
        </List>
      );
    }
    return (
      <p key={bi}>
        {lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(l.replace(/^#+\s*/, ''))}
          </Fragment>
        ))}
      </p>
    );
  });
}

export function AssistantButton() {
  const { settings } = useApp();
  const [open, setOpen] = useState(false);
  if (!settings.assistant_enabled) return null;
  return (
    <>
      <button type="button" className="btn btn-assistant" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span aria-hidden="true">✦</span> <span className="assistant-label">Ask Claude</span>
      </button>
      {/* portal: the top bar's backdrop-filter would otherwise trap position:fixed inside it */}
      {open && createPortal(<AssistantPanel onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function AssistantPanel({ onClose }) {
  const [messages, setMessages] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('openbooks.assistant') || '[]');
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      sessionStorage.setItem('openbooks.assistant', JSON.stringify(messages.slice(-30)));
    } catch {
      /* storage unavailable */
    }
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function ask(text) {
    const question = text.trim();
    if (!question || busy) return;
    const next = [...messages, { role: 'user', content: question }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await post('/assistant/chat', { messages: next.map(({ role, content }) => ({ role, content })) });
      setMessages([...next, { role: 'assistant', content: r.reply, tools: [...new Set(r.tools || [])] }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <aside className="assistant-panel" aria-label="AI assistant">
      <header className="assistant-head">
        <div>
          <strong>✦ Ask Claude</strong>
          <div className="muted small">Answers from your live books · read-only</div>
        </div>
        <div className="assistant-head-actions">
          {messages.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMessages([])}>
              New chat
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close assistant">
            ×
          </button>
        </div>
      </header>
      <div className="assistant-body">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p className="muted">Ask anything about your finances. For example:</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            {m.tools?.length > 0 && <div className="msg-sources">Looked at: {m.tools.map((t) => TOOL_LABELS[t] || t).join(', ')}</div>}
          </div>
        ))}
        {busy && (
          <div className="msg msg-assistant msg-busy">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        )}
        {error && <div className="alert alert-error small">{error}</div>}
        <div ref={endRef} />
      </div>
      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder="Ask about revenue, expenses, customers…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
          disabled={busy}
        />
        <button className="btn btn-primary" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
      <div className="assistant-foot muted">AI can make mistakes. Check important figures in Reports.</div>
    </aside>
  );
}
