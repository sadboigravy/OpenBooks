import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { KIND_INFO, addDays, api, closeTo, fmtDate, money, post, put, round2, today, useApi, useApp } from '../lib.jsx';
import { TaxCodeSelect } from '../components/ui.jsx';
import { AccountSelect, ContactSelect, Field, Loading, isBankAccount, isIncomeAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';
import { ContactForm } from './Contacts.jsx';

const blankLine = (accountId, taxCodeId = '') => ({ item_id: '', description: '', quantity: 1, unit_price: '', account_id: accountId, taxable: true, tax_code_id: taxCodeId, time_entry_ids: [] });

function ItemSelect({ value, onChange }) {
  const { items } = useApp();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} aria-label="Product or service">
      <option value="">— Product/service —</option>
      {items
        .filter((i) => i.active || i.id === value)
        .map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
    </select>
  );
}

function BillableTime({ customerId, usedIds, onAdd }) {
  const { data } = useApi(customerId ? `/time?customer_id=${customerId}&unbilled=1` : null);
  const available = (data || []).filter((t) => !usedIds.includes(t.id));
  const [picked, setPicked] = useState([]);
  if (!available.length) return null;
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <strong>Billable time</strong>
        <span className="badge badge-amber">{available.length}</span>
      </div>
      <p className="muted small">Unbilled hours logged for this customer.</p>
      {available.map((t) => (
        <label key={t.id} className="checkbox time-pick">
          <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
          <span>
            {fmtDate(t.date)} · {t.hours}h · {t.item}
            <small className="muted"> {t.employee}</small>
          </span>
        </label>
      ))}
      <div className="side-panel-actions">
        <button type="button" className="btn btn-sm" onClick={() => setPicked(available.map((t) => t.id))}>
          Select all
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!picked.length}
          onClick={() => {
            onAdd(available.filter((t) => picked.includes(t.id)));
            setPicked([]);
          }}
        >
          Add to {`invoice`}
        </button>
      </div>
    </div>
  );
}

export default function SalesForm({ kind }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const info = KIND_INFO[kind];
  const { settings, accounts, items, notify, taxSetup } = useApp();
  const [preview, setPreview] = useState(null);
  const [calcBusy, setCalcBusy] = useState(false);
  const previewSeq = useRef(0);
  const customers = useApi('/customers');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newCustomer, setNewCustomer] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  // Live tax figures from the server so the form always matches what will be saved
  const previewKey = form
    ? JSON.stringify([form.customer_id, form.amounts_inclusive, form.tax_source, form.tax_rate, form.lines.map((l) => [l.quantity, l.unit_price, l.tax_code_id, l.item_id, l.taxable])])
    : '';
  async function runPreview(useProvider = false) {
    if (!form) return;
    const seq = ++previewSeq.current;
    if (useProvider) setCalcBusy(true);
    try {
      const lines = form.lines.filter((l) => l.description || l.unit_price || l.item_id).map((l) => ({ quantity: l.quantity, unit_price: l.unit_price || 0, tax_code_id: l.tax_code_id || null, item_id: l.item_id || null, taxable: l.taxable }));
      const r = await post('/tax/preview', {
        customer_id: form.customer_id || null,
        amounts_inclusive: form.amounts_inclusive,
        tax_rate: form.tax_source === 'legacy' ? form.tax_rate : 0,
        tax_source: form.tax_source === 'legacy' ? 'codes' : undefined,
        use_provider: useProvider,
        lines,
      });
      if (seq === previewSeq.current) setPreview(r);
    } catch (err) {
      if (seq === previewSeq.current) setPreview({ pending: true, error: err.message });
      if (useProvider) setError(err);
    } finally {
      if (useProvider) setCalcBusy(false);
    }
  }
  useEffect(() => {
    if (!form) return undefined;
    const t = setTimeout(() => runPreview(false), 250);
    return () => clearTimeout(t);
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultIncome = useMemo(() => accounts.find((a) => a.active && a.type === 'income')?.id || '', [accounts]);
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const terms = Number(settings.default_terms_days || 30);
  const defaultCode = Number(taxSetup.settings.default_sales_tax_code_id) || '';
  const automatic = taxSetup.settings.tax_provider === 'stripe_tax';

  useEffect(() => {
    setForm(null);
    setError(null);
    const fromDoc = (d, keepNumber) => ({
      number: keepNumber ? d.number : '',
      customer_id: d.customer_id,
      date: keepNumber ? d.date : today(),
      due_date: keepNumber ? d.due_date : today(terms),
      tax_rate: d.tax_rate,
      amounts_inclusive: d.amounts_inclusive,
      tax_source: d.tax_source,
      memo: d.memo,
      status: d.status,
      deposit_account_id: d.deposit_account_id || defaultBank,
      method: d.method || '',
      reference: d.reference || '',
      lines: d.lines.map((l) => ({ ...l, time_entry_ids: [] })),
    });
    if (id) {
      api(`/invoices/${id}`)
        .then((d) => {
          const f = fromDoc(d, true);
          // re-attach the time entries already billed on this document to its lines
          if (d.time_entry_ids?.length && f.lines.length) f.lines[0].time_entry_ids = d.time_entry_ids;
          setForm({ ...f, was_draft: d.status === 'draft' });
        })
        .catch(setError);
      return;
    }
    const fromEstimate = params.get('from_estimate');
    Promise.all([api(`/invoices/next-number?kind=${kind}`), fromEstimate ? api(`/invoices/${fromEstimate}`) : null])
      .then(([{ number }, est]) => {
        if (est) {
          setForm({ ...fromDoc(est, false), number, status: 'open', estimate_id: est.id, estimate_number: est.number });
        } else {
          setForm({
            number,
            customer_id: params.get('customer_id') ? Number(params.get('customer_id')) : '',
            date: today(),
            due_date: today(terms),
            tax_rate: 0,
            amounts_inclusive: taxSetup.settings.prices_include_tax === 'true',
            memo: '',
            status: kind === 'estimate' ? 'pending' : kind === 'sales_receipt' ? 'paid' : 'open',
            deposit_account_id: defaultBank,
            method: '',
            reference: '',
            lines: [blankLine(defaultIncome, defaultCode)],
          });
        }
      })
      .catch(setError);
  }, [id, kind, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !form) return <div className="alert alert-error">{error.message}</div>;
  if (!form || !customers.data) return <Loading />;

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (idx, changes) => setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === idx ? { ...l, ...changes } : l)) }));
  const pickItem = (idx, itemId) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return setLine(idx, { item_id: '' });
    return setLine(idx, { item_id: item.id, description: item.description || item.name, unit_price: item.price, account_id: item.income_account_id, taxable: item.taxable, tax_code_id: item.taxable ? item.sales_tax_code_id || defaultCode : '' });
  };
  const lineAmount = (l) => round2(Number(l.quantity || 0) * Number(l.unit_price || 0));
  const entered = round2(form.lines.reduce((s, l) => s + lineAmount(l), 0));
  const customer = customers.data?.find((c) => c.id === form.customer_id);
  const legacy = form.tax_source === 'legacy';
  const pending = !preview || preview.pending;
  const subtotal = pending ? entered : preview.subtotal;
  const tax = pending ? 0 : preview.tax;
  const total = pending ? entered : preview.total;
  const usedTime = form.lines.flatMap((l) => l.time_entry_ids || []);

  function addTime(entries) {
    // one line per service/rate
    const groups = {};
    entries.forEach((t) => {
      const key = `${t.item_id}|${t.rate}`;
      groups[key] = groups[key] || { ...t, hours: 0, ids: [], descs: new Set() };
      groups[key].hours += t.hours;
      groups[key].ids.push(t.id);
      if (t.description) groups[key].descs.add(t.description);
    });
    const item = (iid) => items.find((i) => i.id === iid);
    const newLines = Object.values(groups).map((g) => ({
      item_id: g.item_id,
      description: [g.item, ...g.descs].join(' – '),
      quantity: round2(g.hours),
      unit_price: g.rate,
      account_id: item(g.item_id)?.income_account_id || defaultIncome,
      taxable: item(g.item_id)?.taxable ?? true,
      tax_code_id: item(g.item_id)?.taxable === false ? '' : item(g.item_id)?.sales_tax_code_id || defaultCode,
      time_entry_ids: g.ids,
    }));
    setForm((f) => ({ ...f, lines: [...f.lines.filter((l) => l.description || l.unit_price || l.item_id), ...newLines] }));
  }

  async function save(mode, statusOverride) {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, kind, status: statusOverride || form.status };
      const saved = id ? await put(`/invoices/${id}`, payload) : await post('/invoices', payload);
      notify(`${info.label} ${saved.number} saved`);
      setBusy(false);
      if (mode === 'new') {
        if (id) navigate(`${info.path}/new`);
        else setResetKey((k) => k + 1);
      } else if (id) closeTo(navigate, location, `${info.path}/${saved.id}`);
      else navigate(`${info.path}/${saved.id}`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
      document.querySelector('.txn-body')?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  const headline = kind === 'invoice' ? { label: 'Balance due', amount: total } : kind === 'estimate' ? { label: 'Amount', amount: total } : { label: 'Amount received', amount: total };

  return (
    <TxnScreen
      title={`${id ? '' : ''}${info.label}${form.number ? ` ${form.number}` : ''}`}
      fallback={info.path}
      headline={headline}
      busy={busy}
      error={error}
      onSave={(mode) => save(mode)}
      footerLeft={
        kind === 'invoice' &&
        (!id || form.was_draft) && (
          <button type="button" className="btn btn-dark-ghost" disabled={busy} onClick={() => save('close', 'draft')}>
            Save as draft
          </button>
        )
      }
    >
      {form.estimate_number && <div className="alert alert-info">Creating an invoice from estimate {form.estimate_number}. Saving will close the estimate.</div>}
      <div className="txn-grid">
        <div className="txn-main">
          <div className="form-grid cols-4">
            <Field label="Customer *" className="span-2">
              <div className="input-with-btn">
                <ContactSelect contacts={customers.data} value={form.customer_id} onChange={(v) => setField('customer_id', v)} placeholder="Choose a customer…" required />
                <button type="button" className="btn" onClick={() => setNewCustomer(true)}>
                  + New
                </button>
              </div>
            </Field>
            <Field label={`${info.label} no.`}>
              <input value={form.number} onChange={(e) => setField('number', e.target.value)} />
            </Field>
            <Field label="Amounts are">
              <select value={form.amounts_inclusive ? 'inclusive' : 'exclusive'} onChange={(e) => setField('amounts_inclusive', e.target.value === 'inclusive')}>
                <option value="exclusive">Exclusive of tax</option>
                <option value="inclusive">Inclusive of tax</option>
              </select>
            </Field>
            <Field label={`${kind === 'estimate' ? 'Estimate' : kind === 'sales_receipt' ? 'Sales receipt' : 'Invoice'} date *`}>
              <input
                type="date"
                value={form.date}
                required
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value, due_date: e.target.value && kind !== 'sales_receipt' ? addDays(e.target.value, terms) : f.due_date }))}
              />
            </Field>
            {kind !== 'sales_receipt' && (
              <Field label={kind === 'estimate' ? 'Expiration date' : 'Due date *'}>
                <input type="date" value={form.due_date} min={form.date} required onChange={(e) => setField('due_date', e.target.value)} />
              </Field>
            )}
            {kind === 'estimate' && (
              <Field label="Status">
                <select value={form.status} onChange={(e) => setField('status', e.target.value)} disabled={form.status === 'closed'}>
                  <option value="pending">Pending</option>
                  <option value="accepted">Accepted</option>
                  <option value="rejected">Rejected</option>
                  {form.status === 'closed' && <option value="closed">Closed</option>}
                </select>
              </Field>
            )}
            {kind === 'sales_receipt' && (
              <>
                <Field label="Deposit to *">
                  <AccountSelect value={form.deposit_account_id} onChange={(v) => setField('deposit_account_id', v)} filter={isBankAccount} required />
                </Field>
                <Field label="Payment method">
                  <select value={form.method} onChange={(e) => setField('method', e.target.value)}>
                    <option value="">—</option>
                    {['Cash', 'Check', 'Credit card', 'Debit card', 'Bank transfer'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Reference no.">
                  <input value={form.reference} onChange={(e) => setField('reference', e.target.value)} />
                </Field>
              </>
            )}
          </div>

          <div className="lines">
            <table className="table lines-table">
              <thead>
                <tr>
                  <th style={{ width: '3%' }}>#</th>
                  <th style={{ width: '20%' }}>Product/service</th>
                  <th style={{ width: '21%' }}>Description</th>
                  <th style={{ width: '15%' }}>Income account</th>
                  <th className="num" style={{ width: '8%' }}>
                    Qty
                  </th>
                  <th className="num" style={{ width: '11%' }}>
                    Rate
                  </th>
                  <th style={{ width: '13%' }}>Tax</th>
                  <th className="num" style={{ width: '10%' }}>
                    Amount
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {form.lines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="muted line-no">{idx + 1}</td>
                    <td data-label="Product/service">
                      <ItemSelect value={l.item_id} onChange={(v) => pickItem(idx, v)} />
                    </td>
                    <td data-label="Description">
                      <input value={l.description} onChange={(e) => setLine(idx, { description: e.target.value })} placeholder="Description" />
                      {l.time_entry_ids?.length > 0 && <small className="muted">⏱ {l.time_entry_ids.length} time entr{l.time_entry_ids.length === 1 ? 'y' : 'ies'}</small>}
                    </td>
                    <td data-label="Income account">
                      <AccountSelect value={l.account_id} onChange={(v) => setLine(idx, { account_id: v })} filter={isIncomeAccount} required />
                    </td>
                    <td data-label="Qty">
                      <input className="num" type="number" step="any" value={l.quantity} onChange={(e) => setLine(idx, { quantity: e.target.value })} />
                    </td>
                    <td data-label="Rate">
                      <input className="num" type="number" step="0.01" value={l.unit_price} onChange={(e) => setLine(idx, { unit_price: e.target.value })} placeholder="0.00" />
                    </td>
                    <td data-label="Tax">
                      {automatic && !legacy && form.tax_source !== 'codes' ? (
                        <label className="checkbox small" title="Stripe Tax decides the rate from the customer's address">
                          <input type="checkbox" checked={l.taxable} onChange={(e) => setLine(idx, { taxable: e.target.checked })} aria-label="Taxable" /> Auto
                        </label>
                      ) : (
                        <TaxCodeSelect value={l.tax_code_id} onChange={(v) => setLine(idx, { tax_code_id: v, taxable: !!v })} />
                      )}
                    </td>
                    <td data-label="Amount" className="num">
                      {money(lineAmount(l))}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Remove line"
                        disabled={form.lines.length === 1}
                        onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="line-actions">
              <button type="button" className="btn btn-sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blankLine(defaultIncome, defaultCode)] }))}>
                Add lines
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm((f) => ({ ...f, lines: [blankLine(defaultIncome, defaultCode)] }))}>
                Clear all lines
              </button>
            </div>
          </div>

          <div className="form-bottom">
            <Field label={kind === 'estimate' ? 'Message displayed on estimate' : kind === 'sales_receipt' ? 'Message displayed on sales receipt' : 'Message displayed on invoice'} className="grow">
              <textarea rows={3} value={form.memo} onChange={(e) => setField('memo', e.target.value)} />
            </Field>
            <div className="totals">
              <div>
                <span>Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              {pending ? (
                <div className="muted small">
                  <span>{preview?.pending ? 'Tax is calculated automatically by Stripe Tax' : 'Calculating tax…'}</span>
                  {preview?.pending && (
                    <button type="button" className="btn btn-sm" disabled={calcBusy || !form.customer_id} onClick={() => runPreview(true)}>
                      {calcBusy ? 'Calculating…' : 'Calculate tax'}
                    </button>
                  )}
                </div>
              ) : preview.details.length ? (
                preview.details.map((d, i) => (
                  <div key={i} className="tax-detail">
                    <span>
                      {d.name} {d.rate ? <span className="muted">({d.rate}% of {money(d.taxable)})</span> : null}
                    </span>
                    <span>{money(d.tax)}</span>
                  </div>
                ))
              ) : (
                <div>
                  <span>Tax</span>
                  <span>{money(0)}</span>
                </div>
              )}
              {customer?.tax_exempt && <div className="small badge badge-amber">Customer is tax exempt{customer.exemption_reason ? ` · ${customer.exemption_reason}` : ''}</div>}
              {form.amounts_inclusive && !pending && <div className="small muted">Amounts include tax</div>}
              {legacy && <div className="small muted">Saved with the old flat rate ({form.tax_rate}%). Pick tax codes to switch it to the tax engine.</div>}
              <div className="grand">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
            </div>
          </div>
        </div>
        {kind !== 'estimate' && form.customer_id && <BillableTime customerId={form.customer_id} usedIds={usedTime} onAdd={addTime} />}
      </div>
      {newCustomer && (
        <ContactForm
          kind="customers"
          contact={{}}
          onClose={() => setNewCustomer(false)}
          onSaved={(c) => {
            setNewCustomer(false);
            customers.reload();
            if (c) setField('customer_id', c.id);
          }}
        />
      )}
    </TxnScreen>
  );
}
