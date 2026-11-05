import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, downloadCsv, fmtDate, money, post, put, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Tabs, isPayFromAccount } from '../components/ui.jsx';

const FREQ = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };

// ---------------------------------------------------------------- record a tax payment

function PaymentModal({ agency, period, onClose, onSaved }) {
  const { accounts, notify } = useApp();
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const due = period ? Math.max(0, period.net_due - period.paid) : agency.balance;
  const [form, setForm] = useState({
    period_start: period?.start || today().slice(0, 8) + '01',
    period_end: period?.end || today(),
    date: today(),
    amount: Math.abs(due).toFixed(2),
    refund: due < 0,
    account_id: defaultBank,
    reference: '',
    memo: '',
  });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      await post('/tax/payments', { ...form, agency_id: agency.id, amount: form.refund ? -Math.abs(form.amount) : Math.abs(form.amount) });
      notify(form.refund ? 'Tax refund recorded' : 'Tax payment recorded');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      title={`Record tax payment – ${agency.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="taxpay-form">
            Record {form.refund ? 'refund' : 'payment'}
          </button>
        </>
      }
    >
      <form id="taxpay-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Period start *">
          <input type="date" value={form.period_start} onChange={set('period_start')} required />
        </Field>
        <Field label="Period end *">
          <input type="date" value={form.period_end} onChange={set('period_end')} required />
        </Field>
        <Field label={form.refund ? 'Refund amount *' : 'Payment amount *'} hint={period ? `Net due for this period: ${money(period.net_due)}` : `Balance owed: ${money(agency.balance)}`}>
          <input type="number" step="0.01" min="0.01" value={form.amount} onChange={set('amount')} required />
        </Field>
        <Field label="Date *">
          <input type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field label={form.refund ? 'Deposited to *' : 'Paid from *'} className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={isPayFromAccount} required />
        </Field>
        <Field label="Confirmation / reference no.">
          <input value={form.reference} onChange={set('reference')} />
        </Field>
        <Field label="Memo">
          <input value={form.memo} onChange={set('memo')} />
        </Field>
        <label className="checkbox span-2">
          <input type="checkbox" checked={form.refund} onChange={set('refund')} /> This is a refund from the agency (you reclaimed more tax than you collected)
        </label>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ canEdit }) {
  const { data, error, loading, reload } = useApi('/tax/overview');
  const [paying, setPaying] = useState(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!data.agencies.length) {
    return (
      <div className="card">
        <Empty title="No tax agencies yet">Set up the agencies you collect tax for under Rates &amp; codes, or start from a template there.</Empty>
      </div>
    );
  }
  return (
    <>
      {data.unassigned_tax > 0 && <div className="alert alert-info">{money(data.unassigned_tax)} of tax from older flat-rate invoices isn't assigned to an agency.</div>}
      {data.agencies.map((a) => (
        <div key={a.id} className="card table-wrap agency-card">
          <div className="card-header">
            <div>
              <h2>
                {a.name} {!a.active && <span className="badge badge-gray">inactive</span>} {a.source === 'stripe' && <span className="badge badge-blue">from Stripe Tax</span>}
              </h2>
              <div className="muted small">
                Files {FREQ[a.filing_frequency].toLowerCase()}
                {a.registration_number && ` · Reg. ${a.registration_number}`}
              </div>
            </div>
            <div className="agency-balance">
              <div className="kpi-label">{a.balance >= 0 ? 'You owe' : 'Refund due to you'}</div>
              <div className={`kpi-value small-kpi ${a.balance > 0 ? 'warn' : ''}`}>{money(Math.abs(a.balance))}</div>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Period</th>
                <th className="num hide-sm">Taxable sales</th>
                <th className="num">Tax collected</th>
                <th className="num hide-sm">Tax on purchases</th>
                <th className="num">Net due</th>
                <th className="num hide-sm">Paid</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {a.periods.map((p) => (
                <tr key={p.start}>
                  <td>
                    {fmtDate(p.start)} – {fmtDate(p.end)}
                  </td>
                  <td className="num hide-sm">{money(p.taxable_sales)}</td>
                  <td className="num">{money(p.tax_collected)}</td>
                  <td className="num hide-sm">{p.input_tax ? money(p.input_tax) : '—'}</td>
                  <td className="num strong">{money(p.net_due)}</td>
                  <td className="num hide-sm">{p.paid ? money(p.paid) : '—'}</td>
                  <td>
                    {p.status === 'nothing_due' ? (
                      <span className="badge badge-gray">Nothing due</span>
                    ) : p.status === 'filed' ? (
                      <span className="badge badge-green">Paid</span>
                    ) : p.status === 'due' ? (
                      <span className="badge badge-red">Due</span>
                    ) : (
                      <span className="badge badge-blue">Current period</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {canEdit && p.status === 'due' && p.net_due !== 0 && (
                      <button className="btn btn-sm" onClick={() => setPaying({ agency: a, period: p })}>
                        Record payment
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {paying && (
        <PaymentModal
          agency={paying.agency}
          period={paying.period}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- liability report

function LiabilityReport() {
  const { settings } = useApp();
  const [range, setRange] = useState({ start: `${today().slice(0, 4)}-01-01`, end: today() });
  const { data, error, loading } = useApi(`/tax/liability?start=${range.start}&end=${range.end}`);
  function exportCsv() {
    const rows = [['Agency', 'Rate', 'Direction', 'Taxable', 'Tax']];
    data.agencies.forEach((a) => {
      a.rates.forEach((r) => rows.push([a.agency, `${r.name} (${r.rate}%)`, r.direction, r.taxable, r.tax]));
      rows.push([a.agency, 'Net', '', '', a.net], [a.agency, 'Paid', '', '', a.paid], [a.agency, 'Balance', '', '', a.balance]);
    });
    downloadCsv(`sales-tax-${range.start}-${range.end}.csv`, rows);
  }
  return (
    <>
      <div className="card report-controls no-print">
        <Field label="From">
          <input type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} />
        </Field>
        <span className="spacer" />
        <button className="btn" onClick={() => window.print()}>
          Print / PDF
        </button>
        <button className="btn" disabled={!data} onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <ErrorBanner error={error} />
      <div className="card report-paper">
        <div className="report-title">
          <div className="muted">{settings.company_name}</div>
          <h2>Sales Tax Liability</h2>
          <div className="muted">
            {fmtDate(range.start)} – {fmtDate(range.end)}
          </div>
        </div>
        {loading && !data ? (
          <Loading />
        ) : (
          <>
            <table className="table report-table">
              <tbody>
                <tr className="section-row">
                  <td colSpan={2}>Sales in period</td>
                </tr>
                {[
                  ['Total sales', data.totals.total_sales],
                  ['Taxable sales', data.totals.taxable_sales],
                  ['Non-taxable sales', data.totals.non_taxable_sales],
                  ['Exempt sales (tax-exempt customers)', data.totals.exempt_sales],
                ].map(([l, v]) => (
                  <tr key={l}>
                    <td className="indent">{l}</td>
                    <td className="num">{money(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.agencies.length === 0 ? (
              <Empty title="No tax in this period" />
            ) : (
              <table className="table report-table">
                <thead>
                  <tr>
                    <th>Agency / rate</th>
                    <th className="num">Taxable amount</th>
                    <th className="num">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agencies.map((a) => (
                    <Fragment key={a.agency}>
                      <tr className="section-row">
                        <td colSpan={3}>{a.agency}</td>
                      </tr>
                      {a.rates.map((r, i) => (
                        <tr key={i}>
                          <td className="indent">
                            {r.direction === 'purchases' ? 'Tax on purchases – ' : ''}
                            {r.name} <span className="muted small">({r.rate}%)</span>
                          </td>
                          <td className="num">{money(r.taxable)}</td>
                          <td className="num">{r.direction === 'purchases' ? `−${money(r.tax)}` : money(r.tax)}</td>
                        </tr>
                      ))}
                      <tr className="total-row">
                        <td colSpan={2}>Net tax for period</td>
                        <td className="num">{money(a.net)}</td>
                      </tr>
                      <tr>
                        <td colSpan={2} className="indent muted">
                          Payments recorded for this period
                        </td>
                        <td className="num muted">{a.paid ? `−${money(a.paid)}` : '—'}</td>
                      </tr>
                      <tr className="total-row">
                        <td colSpan={2}>Balance</td>
                        <td className="num">{money(a.balance)}</td>
                      </tr>
                    </Fragment>
                  ))}
                  <tr className="grand-row">
                    <td colSpan={2}>Net tax, all agencies</td>
                    <td className="num">{money(data.totals.net)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- rates & codes

function AgencyForm({ agency, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', registration_number: '', filing_frequency: 'quarterly', active: true, ...agency });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      agency?.id ? await put(`/tax/agencies/${agency.id}`, form) : await post('/tax/agencies', form);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${agency.name}?`)) return;
    try {
      await del(`/tax/agencies/${agency.id}`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      title={agency?.id ? 'Edit tax agency' : 'Add tax agency'}
      onClose={onClose}
      footer={
        <>
          {agency?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="agency-form">
            Save
          </button>
        </>
      }
    >
      <form id="agency-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Agency name *" className="span-2">
          <input value={form.name} onChange={set('name')} placeholder="e.g. Washington Department of Revenue" required autoFocus />
        </Field>
        <Field label="Filing frequency">
          <select value={form.filing_frequency} onChange={set('filing_frequency')}>
            {Object.entries(FREQ).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Registration / tax ID">
          <input value={form.registration_number} onChange={set('registration_number')} />
        </Field>
        {agency?.id && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

function RateForm({ rate, agencies, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', agency_id: agencies[0]?.id || '', rate: '', applies_to: 'sales', active: true, ...rate });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      rate?.id ? await put(`/tax/rates/${rate.id}`, form) : await post('/tax/rates', form);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${rate.name}?`)) return;
    try {
      await del(`/tax/rates/${rate.id}`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      title={rate?.id ? 'Edit tax rate' : 'Add tax rate'}
      onClose={onClose}
      footer={
        <>
          {rate?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="rate-form">
            Save
          </button>
        </>
      }
    >
      <form id="rate-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        {rate?.id && <div className="alert alert-info">Changing a rate affects new and edited transactions only. Saved transactions keep the tax they were saved with.</div>}
        <Field label="Rate name *" className="span-2">
          <input value={form.name} onChange={set('name')} placeholder="e.g. State sales tax 6.5%" required autoFocus />
        </Field>
        <Field label="Paid to agency *">
          <select value={form.agency_id} onChange={(e) => setForm({ ...form, agency_id: Number(e.target.value) })} required>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rate (%) *">
          <input type="number" step="0.0001" min="0" max="100" value={form.rate} onChange={set('rate')} required />
        </Field>
        <Field label="Applies to" hint="Use 'Sales and purchases' for VAT/GST you can reclaim on purchases" className="span-2">
          <select value={form.applies_to} onChange={set('applies_to')}>
            <option value="sales">Sales only (US-style sales tax)</option>
            <option value="purchases">Purchases only</option>
            <option value="both">Sales and purchases (VAT / GST)</option>
          </select>
        </Field>
        {rate?.id && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

function CodeForm({ code, rates, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', description: '', rate_ids: [], active: true, ...code });
  const [error, setError] = useState(null);
  const total = rates.filter((r) => form.rate_ids.includes(r.id)).reduce((s, r) => s + r.rate, 0);
  async function save(e) {
    e.preventDefault();
    try {
      code?.id ? await put(`/tax/codes/${code.id}`, form) : await post('/tax/codes', form);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${code.name}?`)) return;
    try {
      await del(`/tax/codes/${code.id}`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      title={code?.id ? 'Edit tax code' : 'Add tax code'}
      onClose={onClose}
      footer={
        <>
          {code?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="code-form">
            Save
          </button>
        </>
      }
    >
      <form id="code-form" onSubmit={save}>
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Code name *" hint="What you'll pick on invoice lines, e.g. a city or 'Standard 20%'">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
          </Field>
          <Field label="Description">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <h3 className="form-section">Component rates · combined {total.toFixed(4).replace(/\.?0+$/, '')}%</h3>
        {rates.length === 0 ? (
          <p className="muted">Add rates first. A code with no rates means "no tax" (e.g. zero-rated or exempt).</p>
        ) : (
          <div className="check-list">
            {rates.map((r) => (
              <label key={r.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={form.rate_ids.includes(r.id)}
                  onChange={(e) => setForm({ ...form, rate_ids: e.target.checked ? [...form.rate_ids, r.id] : form.rate_ids.filter((x) => x !== r.id) })}
                />
                {r.name} — {r.rate}% <span className="muted small">({r.agency})</span>
              </label>
            ))}
          </div>
        )}
        {code?.id && (
          <label className="checkbox" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

function TaxSettingsCard() {
  const { taxSetup, user } = useApp();
  const method = taxSetup.settings.tax_provider === 'stripe_tax' ? 'C) Third-party tax service – Stripe Tax calculates sales tax from customer addresses' : 'Tax codes – the rates below are applied to each line';
  return (
    <div className="card method-summary">
      <div>
        <div className="kpi-label">Tax calculation</div>
        <strong>{method}</strong>
      </div>
      {user.role === 'admin' && (
        <Link className="btn btn-sm" to="/settings#tax-method">
          Change in Settings
        </Link>
      )}
    </div>
  );
}

function Setup({ canEdit }) {
  const { taxSetup, refreshTax, notify } = useApp();
  const templates = useApi('/tax/templates');
  const [modal, setModal] = useState(null);
  const { agencies, rates, codes } = taxSetup;
  const done = () => {
    setModal(null);
    refreshTax();
    notify('Saved');
  };
  async function applyTemplate(key) {
    try {
      await post(`/tax/templates/${key}`);
      await refreshTax();
      notify('Template added. Check the rates match your registration.');
    } catch (err) {
      notify(err.message, 'error');
    }
  }
  return (
    <>
      {!codes.length && canEdit && templates.data && (
        <div className="card welcome">
          <div>
            <h2>Set up sales tax</h2>
            <p className="muted">
              Start from a template, then check the rates against your registration. In the US, add your state and local rates yourself, or switch to Stripe Tax below to
              calculate them from each customer's address.
            </p>
          </div>
          <div className="welcome-actions">
            {templates.data.map((t) => (
              <button key={t.key} className="btn" onClick={() => applyTemplate(t.key)}>
                {t.label.split(' –')[0]}
              </button>
            ))}
          </div>
        </div>
      )}
      <TaxSettingsCard />
      <div className="grid-3">
        <div className="card table-wrap">
          <div className="card-header">
            <h2>Agencies</h2>
            {canEdit && (
              <button className="btn btn-sm" onClick={() => setModal({ type: 'agency', data: {} })}>
                Add
              </button>
            )}
          </div>
          <table className="table compact-pad">
            <tbody>
              {agencies.map((a) => (
                <tr key={a.id} className={`${canEdit ? 'clickable' : ''} ${a.active ? '' : 'inactive'}`} onClick={() => canEdit && setModal({ type: 'agency', data: a })}>
                  <td>
                    {a.name}
                    <div className="small muted">{FREQ[a.filing_frequency]}</div>
                  </td>
                </tr>
              ))}
              {!agencies.length && (
                <tr>
                  <td className="muted">None yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card table-wrap">
          <div className="card-header">
            <h2>Rates</h2>
            {canEdit && (
              <button className="btn btn-sm" disabled={!agencies.length} onClick={() => setModal({ type: 'rate', data: {} })}>
                Add
              </button>
            )}
          </div>
          <table className="table compact-pad">
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className={`${canEdit ? 'clickable' : ''} ${r.active ? '' : 'inactive'}`} onClick={() => canEdit && setModal({ type: 'rate', data: r })}>
                  <td>
                    {r.name}
                    <div className="small muted">
                      {r.agency} · {r.applies_to === 'both' ? 'sales & purchases' : r.applies_to}
                    </div>
                  </td>
                  <td className="num">{r.rate}%</td>
                </tr>
              ))}
              {!rates.length && (
                <tr>
                  <td className="muted">None yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card table-wrap">
          <div className="card-header">
            <h2>Tax codes</h2>
            {canEdit && (
              <button className="btn btn-sm" onClick={() => setModal({ type: 'code', data: {} })}>
                Add
              </button>
            )}
          </div>
          <table className="table compact-pad">
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className={`${canEdit ? 'clickable' : ''} ${c.active ? '' : 'inactive'}`} onClick={() => canEdit && setModal({ type: 'code', data: c })}>
                  <td>
                    {c.name}
                    <div className="small muted">{c.rates.map((r) => r.name).join(' + ') || 'No tax'}</div>
                  </td>
                  <td className="num">{c.sales_rate}%</td>
                </tr>
              ))}
              {!codes.length && (
                <tr>
                  <td className="muted">None yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {modal?.type === 'agency' && <AgencyForm agency={modal.data} onClose={() => setModal(null)} onSaved={done} />}
      {modal?.type === 'rate' && <RateForm rate={modal.data} agencies={agencies.filter((a) => a.active || a.id === modal.data.agency_id)} onClose={() => setModal(null)} onSaved={done} />}
      {modal?.type === 'code' && <CodeForm code={modal.data} rates={rates.filter((r) => r.active || modal.data.rate_ids?.includes(r.id))} onClose={() => setModal(null)} onSaved={done} />}
    </>
  );
}

function Payments({ canEdit }) {
  const { data, error, loading, reload } = useApi('/tax/overview');
  const { notify, taxSetup } = useApp();
  const [paying, setPaying] = useState(null);
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorBanner error={error} />
      {canEdit && taxSetup.agencies.length > 0 && (
        <div className="toolbar">
          <select className="auto-width" value="" onChange={(e) => e.target.value && setPaying(data.agencies.find((a) => a.id === Number(e.target.value)))}>
            <option value="">Record a payment to…</option>
            {data.agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {!data.payments.length ? (
        <div className="card">
          <Empty title="No tax payments recorded" />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Agency</th>
                <th className="hide-sm">Period</th>
                <th className="hide-sm">Account</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td>
                  <td>
                    {p.agency}
                    {p.reference && <div className="small muted">#{p.reference}</div>}
                  </td>
                  <td className="hide-sm">
                    {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                  </td>
                  <td className="hide-sm">{p.account}</td>
                  <td className="num">{p.amount < 0 ? `${money(-p.amount)} refund` : money(p.amount)}</td>
                  <td className="row-actions">
                    {canEdit && (
                      <button
                        className="btn btn-sm btn-danger-ghost"
                        onClick={async () => {
                          if (!window.confirm('Delete this tax payment?')) return;
                          try {
                            await del(`/tax/payments/${p.id}`);
                            notify('Tax payment deleted');
                            reload();
                          } catch (err) {
                            notify(err.message, 'error');
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paying && (
        <PaymentModal
          agency={paying}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            reload();
          }}
        />
      )}
    </>
  );
}

export default function Taxes() {
  const { canEdit, taxSetup } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || (taxSetup.codes.length || taxSetup.agencies.length ? 'overview' : 'setup');
  return (
    <>
      <PageHeader title="Sales tax" subtitle="What you've collected, what you can reclaim, and what you owe each tax agency" />
      <div className="toolbar">
        <Tabs
          tabs={[
            ['overview', 'Overview'],
            ['report', 'Liability report'],
            ['payments', 'Payments'],
            ['setup', 'Rates & codes'],
          ]}
          value={tab}
          onChange={(t) => setParams({ tab: t })}
        />
      </div>
      {tab === 'overview' && <Overview canEdit={canEdit} />}
      {tab === 'report' && <LiabilityReport />}
      {tab === 'payments' && <Payments canEdit={canEdit} />}
      {tab === 'setup' && <Setup canEdit={canEdit} />}
    </>
  );
}
