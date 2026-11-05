import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, closeTo, del, money, post, put, round2, today, useApp } from '../lib.jsx';
import { AccountSelect, Field, Loading } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

const blank = () => ({ account_id: '', description: '', debit: '', credit: '' });

export default function JournalForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { notify } = useApp();
  const [form, setForm] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setForm(null);
    if (id) {
      api(`/journal-entries/${id}`)
        .then((e) => {
          setReadOnly(e.source_type !== 'manual');
          setForm({ date: e.date, reference: e.reference, memo: e.memo, lines: e.lines.map((l) => ({ ...l, debit: l.debit || '', credit: l.credit || '' })) });
        })
        .catch(setError);
    } else {
      setReadOnly(false);
      setForm({ date: today(), reference: '', memo: '', lines: [blank(), blank(), blank(), blank()] });
    }
  }, [id, resetKey]);

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form) return <Loading />;

  const setLine = (i, k, v) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, idx) => (idx === i ? { ...l, [k]: v, ...(k === 'debit' && v ? { credit: '' } : {}), ...(k === 'credit' && v ? { debit: '' } : {}) } : l)),
    }));
  const debits = round2(form.lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const credits = round2(form.lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  const diff = round2(debits - credits);

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, lines: form.lines.filter((l) => l.account_id || Number(l.debit) || Number(l.credit)) };
      id ? await put(`/journal-entries/${id}`, payload) : await post('/journal-entries', payload);
      notify('Journal entry saved');
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate('/journal/new');
        else setResetKey((k) => k + 1);
      } else closeTo(navigate, location, '/journal');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm('Delete this journal entry?')) return;
    try {
      await del(`/journal-entries/${id}`);
      notify('Journal entry deleted');
      closeTo(navigate, location, '/journal');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <TxnScreen
      title={`Journal entry${form.reference ? ` #${form.reference}` : ''}`}
      fallback="/journal"
      headline={{ label: 'Total', amount: debits }}
      onSave={readOnly ? null : save}
      busy={busy}
      error={error}
      disabled={diff !== 0 || debits === 0}
      footerLeft={
        id &&
        !readOnly && (
          <button type="button" className="btn btn-dark-ghost" onClick={remove}>
            Delete
          </button>
        )
      }
    >
      {readOnly && <div className="alert alert-info">This entry was created automatically by another transaction and can only be changed there.</div>}
      <fieldset disabled={readOnly}>
        <div className="form-grid cols-4">
          <Field label="Journal date *">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </Field>
          <Field label="Journal no.">
            <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </div>
        <div className="lines">
          <table className="table lines-table">
            <thead>
              <tr>
                <th style={{ width: '3%' }}>#</th>
                <th style={{ width: '34%' }}>Account</th>
                <th className="num" style={{ width: '14%' }}>
                  Debits
                </th>
                <th className="num" style={{ width: '14%' }}>
                  Credits
                </th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.lines.map((l, i) => (
                <tr key={i}>
                  <td className="muted line-no">{i + 1}</td>
                  <td data-label="Account">
                    <AccountSelect value={l.account_id} onChange={(v) => setLine(i, 'account_id', v)} />
                  </td>
                  <td data-label="Debit">
                    <input className="num" type="number" step="0.01" min="0" aria-label={`Debit, line ${i + 1}`} value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} />
                  </td>
                  <td data-label="Credit">
                    <input className="num" type="number" step="0.01" min="0" aria-label={`Credit, line ${i + 1}`} value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} />
                  </td>
                  <td data-label="Description">
                    <input aria-label={`Description, line ${i + 1}`} value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} />
                  </td>
                  <td>
                    <button type="button" className="icon-btn" disabled={form.lines.length <= 2} aria-label="Remove line" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, idx) => idx !== i) }))}>
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td>
                  <button type="button" className="btn btn-sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blank(), blank()] }))}>
                    Add lines
                  </button>
                </td>
                <td className="num">
                  <strong>{money(debits)}</strong>
                </td>
                <td className="num">
                  <strong>{money(credits)}</strong>
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
          {diff !== 0 && <div className="alert alert-warn">Out of balance by {money(Math.abs(diff))}. Debits must equal credits.</div>}
        </div>
        <Field label="Memo">
          <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
        </Field>
      </fieldset>
    </TxnScreen>
  );
}
