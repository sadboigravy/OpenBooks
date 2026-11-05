// Layout pieces shared by many screens: popover menus, the full-screen
// transaction layout, the money bar, the + New menu and the gear menu.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, closeTo, money, useApp } from '../lib.jsx';
import { ErrorBanner } from './ui.jsx';

export function Popover({ trigger, children, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`popover-wrap ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={`popover popover-${align}`} onClick={(e) => e.target.closest('a,button[data-close]') && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

const NEW_MENU = [
  ['Customers', [['Invoice', '/invoices/new'], ['Receive payment', '/receive-payment'], ['Estimate', '/estimates/new'], ['Sales receipt', '/sales-receipts/new']]],
  ['Vendors', [['Expense', '/expenses/new'], ['Check', '/checks/new'], ['Bill', '/bills/new'], ['Pay bills', '/pay-bills']]],
  ['Employees', [['Run payroll', '/payroll/run'], ['Weekly timesheet', '/time'], ['Add employee', '/employees?new=1']]],
  ['Other', [['Bank deposit', '/deposits/new'], ['Transfer', '/transfers/new'], ['Journal entry', '/journal/new'], ['Product / service', '/items?new=1']]],
];

export function NewMenu() {
  const { canEdit } = useApp();
  if (!canEdit) return null;
  return (
    <Popover
      className="new-menu"
      trigger={({ toggle, open }) => (
        <button type="button" className={`btn-new ${open ? 'open' : ''}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
          <span aria-hidden="true">{open ? '×' : '+'}</span> New
        </button>
      )}
    >
      <div className="mega-menu" role="menu">
        {NEW_MENU.map(([group, items]) => (
          <div key={group} className="mega-col">
            <div className="mega-title">{group}</div>
            {items.map(([label, to]) => (
              <Link key={to} to={to} role="menuitem">
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  );
}

export function GearMenu() {
  const { user } = useApp();
  const cols = [
    ['Your company', [['Company settings', '/settings'], user.role === 'admin' && ['Online payments', '/settings#online-payments'], user.role === 'admin' && ['AI assistant', '/settings#assistant'], user.role === 'admin' && ['Manage users', '/users']]],
    ['Lists', [['Chart of accounts', '/accounts'], ['Products and services', '/items'], ['Employees', '/employees'], ['Customers', '/customers'], ['Vendors', '/vendors']]],
    ['Tools', [['Reconcile', '/reconcile'], ['Bank transactions', '/banking'], ['Journal entries', '/journal']]],
    ['Profile', [['Change password', '/settings#password']]],
  ];
  return (
    <Popover
      align="right"
      trigger={({ toggle, open }) => (
        <button type="button" className={`icon-btn gear-btn ${open ? 'active' : ''}`} onClick={toggle} aria-label="Settings menu" title="Settings">
          ⚙
        </button>
      )}
    >
      <div className="mega-menu gear-menu">
        {cols.map(([group, items]) => (
          <div key={group} className="mega-col">
            <div className="mega-title">{group}</div>
            {items.filter(Boolean).map(([label, to]) => (
              <Link key={to} to={to}>
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  );
}

export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const t = setTimeout(() => api(`/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const go = (link) => {
    setOpen(false);
    setQ('');
    navigate(link);
  };
  return (
    <div className="global-search" ref={ref}>
      <input
        type="search"
        placeholder="Search customers, invoices, vendors…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0].link)}
        aria-label="Search"
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-empty muted">No matches</div>
          ) : (
            results.map((r, i) => (
              <button key={i} type="button" className="search-hit" onClick={() => go(r.link)}>
                <span className="search-type">{r.type}</span>
                <span>
                  <strong>{r.title}</strong>
                  {r.subtitle && <small className="muted"> · {r.subtitle}</small>}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Full-screen transaction form, with a fixed footer offering
 * Cancel / (extra actions) / Save and new / Save and close.
 * `onSave(mode)` is called with "new" or "close".
 */
export function TxnScreen({ title, fallback, headline, onSave, busy, error, footerLeft, children, saveNew = true, saveLabel = 'Save and close', disabled }) {
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => closeTo(navigate, location, fallback);
  useEffect(() => {
    document.body.classList.add('txn-open');
    const onKey = (e) => e.key === 'Escape' && !document.querySelector('.modal-backdrop') && close();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('txn-open');
      window.removeEventListener('keydown', onKey);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form
      className="txn-screen"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(e.nativeEvent.submitter?.dataset.mode || 'close');
      }}
    >
      <header className="txn-header">
        <h1>{title}</h1>
        {headline && (
          <div className="txn-headline">
            <span>{headline.label}</span>
            <strong>{money(headline.amount)}</strong>
          </div>
        )}
        <button type="button" className="icon-btn txn-close" onClick={close} aria-label="Close">
          ×
        </button>
      </header>
      <div className="txn-body">
        <ErrorBanner error={error} />
        {children}
      </div>
      <footer className="txn-footer">
        <button type="button" className="btn btn-dark-ghost" onClick={close}>
          Cancel
        </button>
        {footerLeft}
        <span className="spacer" />
        {onSave && (
          <>
            {saveNew && (
              <button className="btn btn-dark" data-mode="new" disabled={busy || disabled}>
                Save and new
              </button>
            )}
            <button className="btn btn-primary" data-mode="close" disabled={busy || disabled}>
              {busy ? 'Saving…' : saveLabel}
            </button>
          </>
        )}
      </footer>
    </form>
  );
}

/** Coloured summary bar with clickable segments, e.g. Estimates | Overdue | Not due yet | Paid. */
export function MoneyBar({ segments, active, onSelect }) {
  const max = Math.max(1, ...segments.map((s) => s.total || 0));
  return (
    <div className="money-bar card">
      {segments.map((s) => (
        <button
          key={s.key}
          type="button"
          className={`mb-seg ${active === s.key ? 'active' : ''}`}
          onClick={() => onSelect && onSelect(active === s.key ? '' : s.key)}
        >
          <div className="mb-amount">{money(s.total)}</div>
          <div className="mb-label">
            {s.count} {s.label}
          </div>
          <div className="mb-track">
            <div className={`mb-fill mb-${s.tone}`} style={{ width: `${Math.max(4, (100 * (s.total || 0)) / max)}%` }} />
          </div>
        </button>
      ))}
    </div>
  );
}
