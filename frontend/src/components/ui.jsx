import { useEffect, useMemo } from 'react';
import { useApp } from '../lib.jsx';

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="alert alert-error">{error.message || String(error)}</div>;
}

export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" /> Loading…
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

const STATUS_CLASS = {
  paid: 'badge-green',
  open: 'badge-blue',
  partial: 'badge-amber',
  overdue: 'badge-red',
  draft: 'badge-gray',
  void: 'badge-gray',
  review: 'badge-amber',
  categorized: 'badge-green',
  excluded: 'badge-gray',
};
const STATUS_TEXT = { review: 'For review', categorized: 'Categorized', excluded: 'Excluded' };

export function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] || 'badge-gray'}`}>
      {STATUS_TEXT[status] || status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_LABEL = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

/** <select> of accounts, grouped by type. `filter` narrows the list. */
export function AccountSelect({ value, onChange, filter, placeholder = 'Choose an account…', required, id }) {
  const { accounts } = useApp();
  const groups = useMemo(() => {
    const list = (accounts || []).filter((a) => a.active && (!filter || filter(a)));
    return TYPE_ORDER.map((t) => [t, list.filter((a) => a.type === t)]).filter(([, l]) => l.length);
  }, [accounts, filter]);
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} required={required}>
      <option value="">{placeholder}</option>
      {groups.map(([type, list]) => (
        <optgroup key={type} label={TYPE_LABEL[type]}>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export const isBankAccount = (a) => ['bank', 'cash'].includes(a.subtype);
export const isPayFromAccount = (a) => ['bank', 'cash', 'credit_card'].includes(a.subtype);
export const isIncomeAccount = (a) => a.type === 'income';
export const isCategoryAccount = (a) =>
  ['expense', 'asset', 'liability', 'equity'].includes(a.type) &&
  !['accounts_receivable', 'accounts_payable'].includes(a.subtype);

export function ContactSelect({ contacts, value, onChange, placeholder, required }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} required={required}>
      <option value="">{placeholder}</option>
      {(contacts || [])
        .filter((c) => c.active || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.company ? ` (${c.company})` : ''}
          </option>
        ))}
    </select>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={`tab ${value === key ? 'active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** <select> of tax codes. `direction` filters to codes with rates for sales or purchases. */
export function TaxCodeSelect({ value, onChange, direction = 'sales', placeholder = 'No tax', ariaLabel = 'Tax code' }) {
  const { taxSetup } = useApp();
  const codes = (taxSetup?.codes || []).filter((c) => (c.active || c.id === value) && (direction === 'sales' ? c.rates.some((r) => r.applies_to !== 'purchases') || !c.rates.length : c.rates.some((r) => r.applies_to !== 'sales')));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} aria-label={ariaLabel}>
      <option value="">{placeholder}</option>
      {codes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({(direction === 'sales' ? c.sales_rate : c.purchase_rate) || 0}%)
        </option>
      ))}
    </select>
  );
}
