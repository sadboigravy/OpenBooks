// Shared helpers: API client, app context, formatting, data hook.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------------ API client

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('openbooks:signed-out'));
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

// ------------------------------------------------------------------ data hook

export function useApi(path) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const counter = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const id = ++counter.current;
    setState((s) => ({ ...s, loading: true }));
    api(path)
      .then((data) => id === counter.current && setState({ data, loading: false, error: null }))
      .catch((error) => id === counter.current && setState({ data: null, loading: false, error }));
  }, [path]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

// ------------------------------------------------------------------ app context

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// ------------------------------------------------------------------ formatting

let currency = 'USD';
export function setCurrency(code) {
  currency = code || 'USD';
}

export function money(value, { blankZero = false } = {}) {
  const n = Number(value || 0);
  if (blankZero && n === 0) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const SOURCE_LABELS = {
  manual: 'Journal entry',
  invoice: 'Invoice',
  estimate: 'Estimate',
  sales_receipt: 'Sales receipt',
  invoice_payment: 'Payment',
  payment: 'Payment',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  expense: 'Expense',
  check: 'Check',
  bank: 'Bank transaction',
  deposit: 'Deposit',
  transfer: 'Transfer',
  payroll: 'Payroll',
  payroll_tax_payment: 'Payroll tax payment',
  tax_payment: 'Sales tax payment',
};

/** Where to open a transaction, given its ledger source (or list row type). */
export function sourceLink(type, id, entryId) {
  switch (type) {
    case 'invoice':
      return id && `/invoices/${id}`;
    case 'estimate':
      return id && `/estimates/${id}`;
    case 'sales_receipt':
      return id && `/sales-receipts/${id}`;
    case 'bill':
      return id && `/bills/${id}`;
    case 'expense':
    case 'check':
      return id && `/expenses/${id}/edit`;
    case 'payroll':
      return id && `/payroll/runs/${id}`;
    case 'tax_payment':
      return '/taxes?tab=payments';
    case 'deposit':
      return `/deposits/${entryId || id}`;
    case 'transfer':
      return `/transfers/${entryId || id}`;
    case 'manual':
      return `/journal/${entryId || id}`;
    default:
      return null;
  }
}

export const KIND_INFO = {
  invoice: { label: 'Invoice', path: '/invoices', plural: 'Invoices' },
  estimate: { label: 'Estimate', path: '/estimates', plural: 'Estimates' },
  sales_receipt: { label: 'Sales receipt', path: '/sales-receipts', plural: 'Sales receipts' },
};

/** Close a full-screen form: go back if we came from inside the app, else to a fallback page. */
export function closeTo(navigate, location, fallback) {
  if (location.key && location.key !== 'default') navigate(-1);
  else navigate(fallback);
}

export function startOfWeek(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const diff = (dt.getDay() + 6) % 7; // Monday = 0
  dt.setDate(dt.getDate() - diff);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Debounced server-side tax preview for a form. Returns null while loading. */
export function useTaxPreview(payload, enabled = true) {
  const [preview, setPreview] = useState(null);
  const key = JSON.stringify(payload);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return undefined;
    }
    const id = ++seq.current;
    const t = setTimeout(() => {
      post('/tax/preview', payload)
        .then((r) => id === seq.current && setPreview(r))
        .catch(() => id === seq.current && setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return preview;
}
