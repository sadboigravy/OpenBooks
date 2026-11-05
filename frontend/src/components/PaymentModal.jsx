import { useMemo, useState } from 'react';
import { post, today, useApp } from '../lib.jsx';
import { AccountSelect, ErrorBanner, Field, Modal, isBankAccount, isPayFromAccount } from './ui.jsx';

/** Record a payment received on an invoice, or a payment made on a bill. */
export default function PaymentModal({ doc, kind, onClose, onSaved }) {
  const { accounts, notify } = useApp();
  const filter = kind === 'invoice' ? isBankAccount : isPayFromAccount;
  const firstBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState({ date: today(), amount: doc.balance, account_id: firstBank, method: '', reference: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await post(`/${kind}s/${doc.id}/payments`, form);
      notify(kind === 'invoice' ? 'Payment recorded' : 'Bill payment recorded');
      onSaved(updated);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={kind === 'invoice' ? `Receive payment – ${doc.number}` : `Pay bill – ${doc.vendor}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="payment-form" disabled={busy}>
            Save payment
          </button>
        </>
      }
    >
      <form id="payment-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Payment date *">
          <input type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field label="Amount *" hint={`Balance due: ${doc.balance.toFixed(2)}`}>
          <input type="number" step="0.01" min="0.01" max={doc.balance} value={form.amount} onChange={set('amount')} required />
        </Field>
        <Field label={kind === 'invoice' ? 'Deposit to *' : 'Paid from *'} className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={filter} required />
        </Field>
        <Field label="Method">
          <select value={form.method} onChange={set('method')}>
            <option value="">—</option>
            {['ACH / bank transfer', 'Check', 'Cash', 'Credit card', 'Other'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Reference #">
          <input value={form.reference} onChange={set('reference')} />
        </Field>
      </form>
    </Modal>
  );
}
