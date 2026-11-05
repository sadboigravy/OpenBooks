import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, closeTo, del, money, post, put, today, useApp } from '../lib.jsx';
import { AccountSelect, Field, Loading } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

const transferable = (a) => ['asset', 'liability', 'equity'].includes(a.type) && !['accounts_receivable', 'accounts_payable'].includes(a.subtype);

export default function TransferForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { accounts, notify } = useApp();
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setForm(null);
    if (id) api(`/transfers/${id}`).then(setForm).catch(setError);
    else setForm({ date: today(), from_account_id: '', to_account_id: '', amount: '', memo: '' });
  }, [id, resetKey]);

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form) return <Loading />;
  const bal = (accountId) => accounts.find((a) => a.id === accountId)?.balance;

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      id ? await put(`/transfers/${id}`, form) : await post('/transfers', form);
      notify('Transfer saved');
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate('/transfers/new');
        else setResetKey((k) => k + 1);
      } else closeTo(navigate, location, '/banking');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm('Delete this transfer?')) return;
    try {
      await del(`/journal-entries/${id}`);
      notify('Transfer deleted');
      closeTo(navigate, location, '/banking');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <TxnScreen
      title="Transfer"
      fallback="/banking"
      headline={{ label: 'Amount', amount: Number(form.amount || 0) }}
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
      <div className="transfer-grid">
        <Field label="Transfer funds from *" hint={form.from_account_id ? `Balance ${money(bal(form.from_account_id))}` : null}>
          <AccountSelect value={form.from_account_id} onChange={(v) => setForm({ ...form, from_account_id: v })} filter={transferable} required />
        </Field>
        <Field label="Transfer funds to *" hint={form.to_account_id ? `Balance ${money(bal(form.to_account_id))}` : null}>
          <AccountSelect value={form.to_account_id} onChange={(v) => setForm({ ...form, to_account_id: v })} filter={(a) => transferable(a) && a.id !== form.from_account_id} required />
        </Field>
        <Field label="Transfer amount *">
          <input type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
        </Field>
        <Field label="Date *">
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </Field>
        <Field label="Memo" className="span-2">
          <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
        </Field>
      </div>
    </TxnScreen>
  );
}
