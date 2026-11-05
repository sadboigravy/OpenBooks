import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { addDays, api, closeTo, post, put, today, useApi, useApp, useTaxPreview } from '../lib.jsx';
import { ContactSelect, Field, Loading } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';
import CategoryLines, { blankCategoryLine, purchasePreviewPayload, usePurchaseTaxEnabled } from '../components/CategoryLines.jsx';
import { ContactForm } from './Contacts.jsx';

export default function BillForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { notify, settings, taxSetup } = useApp();
  const taxEnabled = usePurchaseTaxEnabled();
  const defaultPurchaseCode = Number(taxSetup.settings.default_purchase_tax_code_id) || '';
  const vendors = useApi('/vendors');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newVendor, setNewVendor] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const preview = useTaxPreview(form ? purchasePreviewPayload(form.lines, form.amounts_inclusive) : {}, !!form && (taxEnabled || form.lines.some((l) => l.tax_code_id)));
  const terms = Number(settings.default_terms_days || 30);

  useEffect(() => {
    setForm(null);
    if (id) {
      api(`/bills/${id}`)
        .then((b) => setForm({ vendor_id: b.vendor_id, number: b.number, date: b.date, due_date: b.due_date, memo: b.memo, amounts_inclusive: b.amounts_inclusive, lines: b.lines.map((l) => ({ ...l, tax_code_id: l.tax_code_id || '' })) }))
        .catch(setError);
    } else {
      setForm({
        vendor_id: params.get('vendor_id') ? Number(params.get('vendor_id')) : '',
        number: '',
        date: today(),
        due_date: today(terms),
        memo: '',
        amounts_inclusive: taxSetup.settings.prices_include_tax === 'true',
        lines: [blankCategoryLine(defaultPurchaseCode)],
      });
    }
  }, [id, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form || !vendors.data) return <Loading />;
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      const saved = id ? await put(`/bills/${id}`, form) : await post('/bills', form);
      notify('Bill saved');
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate('/bills/new');
        else setResetKey((k) => k + 1);
      } else if (id) closeTo(navigate, location, `/bills/${saved.id}`);
      else navigate(`/bills/${saved.id}`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <TxnScreen title="Bill" fallback="/bills" headline={{ label: 'Balance due', amount: preview ? preview.total : form.lines.reduce((s, l) => s + Number(l.amount || 0), 0) }} onSave={save} busy={busy} error={error}>
      <div className="form-grid cols-4">
        <Field label="Vendor *" className="span-2">
          <div className="input-with-btn">
            <ContactSelect contacts={vendors.data} value={form.vendor_id} onChange={(v) => setField('vendor_id', v)} placeholder="Choose a vendor…" required />
            <button type="button" className="btn" onClick={() => setNewVendor(true)}>
              + New
            </button>
          </div>
        </Field>
        <Field label="Bill no.">
          <input value={form.number} onChange={(e) => setField('number', e.target.value)} />
        </Field>
        <div />
        <Field label="Bill date *">
          <input
            type="date"
            value={form.date}
            required
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value, due_date: e.target.value ? addDays(e.target.value, terms) : f.due_date }))}
          />
        </Field>
        <Field label="Due date *">
          <input type="date" value={form.due_date} min={form.date} required onChange={(e) => setField('due_date', e.target.value)} />
        </Field>
      </div>
      <div className="section-row-head">
        <h2 className="section-title">Category details</h2>
        {(taxEnabled || form.amounts_inclusive) && (
          <select className="auto-width" value={form.amounts_inclusive ? 'inclusive' : 'exclusive'} onChange={(e) => setField('amounts_inclusive', e.target.value === 'inclusive')} aria-label="Amounts are">
            <option value="exclusive">Amounts exclusive of tax</option>
            <option value="inclusive">Amounts inclusive of tax</option>
          </select>
        )}
      </div>
      <CategoryLines lines={form.lines} onChange={(lines) => setField('lines', lines)} preview={preview} inclusive={form.amounts_inclusive} />
      <Field label="Memo">
        <textarea rows={2} value={form.memo} onChange={(e) => setField('memo', e.target.value)} />
      </Field>
      {newVendor && (
        <ContactForm
          kind="vendors"
          contact={{}}
          onClose={() => setNewVendor(false)}
          onSaved={(c) => {
            setNewVendor(false);
            vendors.reload();
            if (c) setField('vendor_id', c.id);
          }}
        />
      )}
    </TxnScreen>
  );
}
