import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, closeTo, del, money, post, put, round2, today, useApp } from '../lib.jsx';
import { AccountSelect, Field, Loading, isBankAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

const blank = () => ({ account_id: '', description: '', amount: '' });
const sourceFilter = (a) => !['accounts_receivable', 'accounts_payable'].includes(a.subtype);

export default function DepositForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { accounts, notify } = useApp();
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setForm(null);
    if (id) api(`/deposits/${id}`).then(setForm).catch(setError);
    else setForm({ account_id: defaultBank, date: today(), memo: '', reference: '', lines: [blank(), blank()] });
  }, [id, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form) return <Loading />;
  const total = round2(form.lines.reduce((s, l) => s + Number(l.amount || 0), 0));
  const setLine = (i, k, v) => setForm((f) => ({ ...f, lines: f.lines.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)) }));

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, lines: form.lines.filter((l) => l.account_id && Number(l.amount)) };
      id ? await put(`/deposits/${id}`, payload) : await post('/deposits', payload);
      notify(`Deposit of ${money(total)} saved`);
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate('/deposits/new');
        else setResetKey((k) => k + 1);
      } else closeTo(navigate, location, '/banking');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm('Delete this deposit?')) return;
    try {
      await del(`/journal-entries/${id}`);
      notify('Deposit deleted');
      closeTo(navigate, location, '/banking');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <TxnScreen
      title="Bank deposit"
      fallback="/banking"
      headline={{ label: 'Amount', amount: total }}
      onSave={save}
      busy={busy}
      error={error}
      footerLeft={
        id && (
          <button type="button" className="btn btn-dark-ghost" onClick={remove}>
            Delete
          </button>
        )
      }
    >
      <div className="form-grid cols-4">
        <Field label="Account *" className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={isBankAccount} required />
        </Field>
        <Field label="Date *">
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </Field>
        <Field label="Ref no.">
          <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
      </div>
      <h2 className="section-title">Add funds to this deposit</h2>
      <p className="muted small">For customer payments against invoices, use Receive payment instead so the invoices are marked paid.</p>
      <div className="lines">
        <table className="table lines-table">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>Received from (account)</th>
              <th>Description</th>
              <th className="num" style={{ width: '18%' }}>
                Amount
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.lines.map((l, i) => (
              <tr key={i}>
                <td data-label="Account">
                  <AccountSelect value={l.account_id} onChange={(v) => setLine(i, 'account_id', v)} filter={(a) => sourceFilter(a) && a.id !== form.account_id} />
                </td>
                <td data-label="Description">
                  <input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} />
                </td>
                <td data-label="Amount">
                  <input className="num" type="number" step="0.01" value={l.amount} onChange={(e) => setLine(i, 'amount', e.target.value)} placeholder="0.00" />
                </td>
                <td>
                  <button type="button" className="icon-btn" aria-label="Remove line" disabled={form.lines.length === 1} onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, idx) => idx !== i) }))}>
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                <button type="button" className="btn btn-sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blank()] }))}>
                  Add lines
                </button>
              </td>
              <td className="num">
                <strong>{money(total)}</strong>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <Field label="Memo">
        <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
      </Field>
    </TxnScreen>
  );
}
