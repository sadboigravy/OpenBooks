import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, closeTo, fmtDate, money, post, round2, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, ContactSelect, Empty, Field, Loading, isBankAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

export default function ReceivePayment() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { accounts, notify } = useApp();
  const customers = useApi('/customers');
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState({
    customer_id: params.get('customer_id') ? Number(params.get('customer_id')) : '',
    date: today(),
    account_id: defaultBank,
    method: '',
    reference: '',
  });
  const [invoices, setInvoices] = useState(null);
  const [applied, setApplied] = useState({});
  const [received, setReceived] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInvoices(null);
    setApplied({});
    setReceived('');
    if (!form.customer_id) return;
    api(`/invoices?customer_id=${form.customer_id}&status=unpaid`).then((list) => {
      const sorted = [...list].sort((a, b) => a.due_date.localeCompare(b.due_date));
      setInvoices(sorted);
      const preselect = Number(params.get('invoice_id'));
      const target = sorted.find((i) => i.id === preselect);
      if (target) {
        setApplied({ [target.id]: target.balance });
        setReceived(String(target.balance));
      }
    });
  }, [form.customer_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = round2(Object.values(applied).reduce((s, v) => s + Number(v || 0), 0));

  // Typing an "amount received" spreads it over the oldest invoices first
  function distribute(value) {
    setReceived(value);
    let left = Number(value || 0);
    const next = {};
    (invoices || []).forEach((inv) => {
      const amt = round2(Math.min(left, inv.balance));
      if (amt > 0) next[inv.id] = amt;
      left = round2(left - amt);
    });
    setApplied(next);
  }

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      const applications = Object.entries(applied)
        .filter(([, v]) => Number(v) > 0)
        .map(([invoice_id, amount]) => ({ invoice_id: Number(invoice_id), amount }));
      const r = await post('/payments/receive', { ...form, applications });
      notify(`Payment of ${money(r.total)} recorded`);
      setBusy(false);
      if (mode === 'new') {
        setForm((f) => ({ ...f, customer_id: '', reference: '' }));
        setInvoices(null);
        setApplied({});
        setReceived('');
      } else closeTo(navigate, location, '/sales');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <TxnScreen title="Receive payment" fallback="/sales" headline={{ label: 'Amount received', amount: total }} onSave={save} busy={busy} error={error} disabled={total <= 0}>
      <div className="form-grid cols-4">
        <Field label="Customer *" className="span-2">
          {customers.data ? (
            <ContactSelect contacts={customers.data} value={form.customer_id} onChange={(v) => setForm({ ...form, customer_id: v })} placeholder="Choose a customer…" required />
          ) : (
            <select disabled>
              <option>Loading customers…</option>
            </select>
          )}
        </Field>
        <Field label="Payment date *">
          <input type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field label="Amount received" hint="Applied to the oldest invoices first">
          <input type="number" step="0.01" min="0" value={received} onChange={(e) => distribute(e.target.value)} disabled={!invoices?.length} />
        </Field>
        <Field label="Payment method">
          <select value={form.method} onChange={set('method')}>
            <option value="">—</option>
            {['ACH / bank transfer', 'Check', 'Cash', 'Credit card', 'Other'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Reference no.">
          <input value={form.reference} onChange={set('reference')} />
        </Field>
        <Field label="Deposit to *" className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={isBankAccount} required />
        </Field>
      </div>

      <h2 className="section-title">Outstanding transactions</h2>
      {!form.customer_id ? (
        <Empty title="Choose a customer">Their unpaid invoices will appear here.</Empty>
      ) : !invoices ? (
        <Loading />
      ) : invoices.length === 0 ? (
        <Empty title="No open invoices for this customer" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <th>Description</th>
                <th className="hide-sm">Due date</th>
                <th className="num hide-sm">Original amount</th>
                <th className="num">Open balance</th>
                <th className="num" style={{ width: 160 }}>
                  Payment
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Number(applied[inv.id]) > 0}
                      onChange={(e) => setApplied({ ...applied, [inv.id]: e.target.checked ? inv.balance : 0 })}
                      aria-label={`Apply to ${inv.number}`}
                    />
                  </td>
                  <td>
                    Invoice # {inv.number} <small className="muted">({fmtDate(inv.date)})</small>
                    {inv.status === 'overdue' && <span className="badge badge-red">Overdue</span>}
                  </td>
                  <td className="hide-sm">{fmtDate(inv.due_date)}</td>
                  <td className="num hide-sm">{money(inv.total)}</td>
                  <td className="num">{money(inv.balance)}</td>
                  <td>
                    <input className="num" type="number" step="0.01" min="0" max={inv.balance} value={applied[inv.id] ?? ''} onChange={(e) => setApplied({ ...applied, [inv.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="hide-sm" />
                <td className="num">
                  <strong>Amount to apply</strong>
                </td>
                <td className="num">
                  <strong>{money(total)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </TxnScreen>
  );
}
