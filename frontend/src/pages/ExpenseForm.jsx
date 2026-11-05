import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, closeTo, del, post, put, today, useApi, useApp, useTaxPreview } from '../lib.jsx';
import { AccountSelect, ContactSelect, Field, Loading, isBankAccount, isPayFromAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';
import CategoryLines, { blankCategoryLine, purchasePreviewPayload, usePurchaseTaxEnabled } from '../components/CategoryLines.jsx';

/** Expense (paid by bank/card/cash) or Check (paid from a bank account). */
export default function ExpenseForm({ check: isCheckRoute }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { accounts, notify, taxSetup } = useApp();
  const taxEnabled = usePurchaseTaxEnabled();
  const defaultPurchaseCode = Number(taxSetup.settings.default_purchase_tax_code_id) || '';
  const vendors = useApi('/vendors');
  const defaultFrom = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const preview = useTaxPreview(form ? purchasePreviewPayload(form.lines, form.amounts_inclusive) : {}, !!form && (taxEnabled || form.lines.some((l) => l.tax_code_id)));

  useEffect(() => {
    setForm(null);
    if (id) {
      api(`/expenses/${id}`)
        .then((e) => setForm({ ...e, vendor_id: e.vendor_id || '', payee: e.vendor_id ? '' : e.payee, lines: e.lines.map((l) => ({ ...l, tax_code_id: l.tax_code_id || '' })) }))
        .catch(setError);
    } else {
      setForm({
        date: today(),
        vendor_id: params.get('vendor_id') ? Number(params.get('vendor_id')) : '',
        payee: '',
        account_id: defaultFrom,
        method: isCheckRoute ? 'Check' : '',
        reference: '',
        memo: '',
        amounts_inclusive: taxSetup.settings.prices_include_tax === 'true',
        lines: [blankCategoryLine(defaultPurchaseCode)],
      });
    }
  }, [id, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form || !vendors.data) return <Loading />;
  const isCheck = form.method === 'Check';
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const total = preview ? preview.total : form.lines.reduce((s, l) => s + Number(l.amount || 0), 0);

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      id ? await put(`/expenses/${id}`, form) : await post('/expenses', form);
      notify(isCheck ? 'Check saved' : 'Expense saved');
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate(isCheck ? '/checks/new' : '/expenses/new');
        else setResetKey((k) => k + 1);
      } else closeTo(navigate, location, '/expenses');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm('Delete this transaction?')) return;
    try {
      await del(`/expenses/${id}`);
      notify('Deleted');
      closeTo(navigate, location, '/expenses');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <TxnScreen
      title={isCheck ? `Check${form.reference ? ` #${form.reference}` : ''}` : 'Expense'}
      fallback="/expenses"
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
        <Field label="Payee" className="span-2">
          <ContactSelect contacts={vendors.data} value={form.vendor_id} onChange={(v) => set('vendor_id', v)} placeholder="— Other payee (type below) —" />
        </Field>
        {!form.vendor_id ? (
          <Field label="Payee name *" className="span-2">
            <input value={form.payee} onChange={(e) => set('payee', e.target.value)} placeholder="Who you paid" required />
          </Field>
        ) : (
          <div className="span-2" />
        )}
        <Field label={isCheck ? 'Bank account *' : 'Payment account *'} className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => set('account_id', v)} filter={isCheck ? isBankAccount : isPayFromAccount} required />
        </Field>
        <Field label="Payment date *">
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required />
        </Field>
        {isCheck ? (
          <Field label="Check no.">
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </Field>
        ) : (
          <Field label="Payment method">
            <select value={form.method} onChange={(e) => set('method', e.target.value)}>
              <option value="">—</option>
              {['Debit card', 'Credit card', 'Cash', 'Check', 'Bank transfer'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        )}
        {!isCheck && (
          <Field label="Ref no.">
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </Field>
        )}
      </div>
      <div className="section-row-head">
        <h2 className="section-title">Category details</h2>
        {(taxEnabled || form.amounts_inclusive) && (
          <select className="auto-width" value={form.amounts_inclusive ? 'inclusive' : 'exclusive'} onChange={(e) => set('amounts_inclusive', e.target.value === 'inclusive')} aria-label="Amounts are">
            <option value="exclusive">Amounts exclusive of tax</option>
            <option value="inclusive">Amounts inclusive of tax</option>
          </select>
        )}
      </div>
      <CategoryLines lines={form.lines} onChange={(lines) => set('lines', lines)} preview={preview} inclusive={form.amounts_inclusive} />
      <Field label="Memo">
        <textarea rows={2} value={form.memo} onChange={(e) => set('memo', e.target.value)} />
      </Field>
    </TxnScreen>
  );
}
