import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, put, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Loading } from './ui.jsx';

export const METHODS = [
  {
    key: 'manual',
    letter: 'A',
    title: 'Manually entered',
    text: 'You enter your own sales tax rates, and fixed withholding percentages for each employee.',
  },
  {
    key: 'us_tables',
    letter: 'B',
    title: 'US tax tables (unverified)',
    text: 'Payroll withholding is calculated from built-in US federal tables and each W-4. Verify the tables before relying on them.',
  },
  {
    key: 'stripe_tax',
    letter: 'C',
    title: 'Third-party tax service',
    text: "Stripe Tax works out sales tax from each customer's address. Payroll uses your choice of method below.",
  },
];

function CodeSelect({ value, onChange, codes, purchase }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">No tax</option>
      {codes.map((c) => (
        <option key={c.id} value={c.id}>
          {purchase ? `${c.label.split(' (')[0]} (${c.purchase_rate}%)` : c.label}
        </option>
      ))}
    </select>
  );
}

/** Settings → Tax calculation: choose A / B / C, then that method's own settings. */
export default function TaxMethodSettings() {
  const { notify, refreshTax, refreshSettings } = useApp();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [applyToEmployees, setApplyToEmployees] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/tax/method').then((c) => {
      setCfg(c);
      setForm({
        method: c.method,
        payroll_default: c.payroll_default,
        default_sales_tax_code_id: c.default_sales_tax_code_id,
        default_purchase_tax_code_id: c.default_purchase_tax_code_id,
        prices_include_tax: c.prices_include_tax === 'true',
        stripe_default_tax_code: c.stripe_default_tax_code,
      });
    });
  useEffect(() => {
    load().catch(setError);
  }, []);

  if (error && !cfg) return <ErrorBanner error={error} />;
  if (!cfg || !form) return <Loading />;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const payrollTarget = form.method === 'us_tables' ? 'tables' : form.method === 'manual' ? 'percent' : form.payroll_default;
  const mismatched = payrollTarget === 'tables' ? cfg.employees.percent : cfg.employees.tables;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await put('/tax/method', { ...form, apply_to_employees: applyToEmployees });
      await Promise.all([load(), refreshTax(), refreshSettings()]);
      setApplyToEmployees(false);
      notify(r.employees_switched ? `Tax method saved · ${r.employees_switched} employee(s) switched` : 'Tax method saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const salesDefaults = (
    <>
      <Field label="Default tax code for sales">
        <CodeSelect value={form.default_sales_tax_code_id} onChange={(v) => set('default_sales_tax_code_id', v)} codes={cfg.codes} />
      </Field>
      <Field label="Default tax code for purchases" hint="Leave as No tax in the US; use for reclaimable VAT/GST">
        <CodeSelect value={form.default_purchase_tax_code_id} onChange={(v) => set('default_purchase_tax_code_id', v)} codes={cfg.codes} purchase />
      </Field>
    </>
  );
  const inclusive = (
    <label className="checkbox span-2">
      <input type="checkbox" checked={form.prices_include_tax} onChange={(e) => set('prices_include_tax', e.target.checked)} /> New documents use prices that already include tax
    </label>
  );

  return (
    <form className="card form-card" onSubmit={save} id="tax-method">
      <div className="card-header">
        <div>
          <h2>Tax calculation</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            How OpenBooks works out sales tax and payroll withholding.
          </p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="method-choices" role="radiogroup" aria-label="Tax calculation method">
        {METHODS.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={form.method === m.key}
            className={`choice method-choice ${form.method === m.key ? 'selected' : ''}`}
            onClick={() => set('method', m.key)}
          >
            <span className="method-letter">{m.letter}</span>
            <strong>{m.title}</strong>
            <span className="muted small">{m.text}</span>
          </button>
        ))}
      </div>

      <div className="method-panel">
        {form.method === 'manual' && (
          <>
            <h3 className="form-section">Sales tax</h3>
            <p className="muted small">
              Set up your tax agencies, rates and tax codes under <Link to="/taxes?tab=setup">Taxes → Sales tax → Rates &amp; codes</Link>
              {cfg.codes.length === 0 && ' (none yet)'}.
            </p>
            <div className="form-grid">
              {salesDefaults}
              {inclusive}
            </div>
            <h3 className="form-section">Payroll</h3>
            <p className="muted small">New employees use fixed withholding percentages, entered on each employee's profile.</p>
          </>
        )}

        {form.method === 'us_tables' && (
          <>
            <h3 className="form-section">Payroll tax tables · {cfg.payroll_tables.year}</h3>
            {!cfg.payroll_tables.has_federal ? (
              <div className="alert alert-warn small">
                There are no federal tables for {cfg.payroll_tables.year}. Copy last year forward under <Link to="/taxes/payroll">Taxes → Payroll tax</Link> and update them.
              </div>
            ) : cfg.payroll_tables.unverified > 0 ? (
              <div className="alert alert-warn small">
                {cfg.payroll_tables.unverified} of {cfg.payroll_tables.count} tables are unverified. Check them against IRS Publication 15-T and mark them verified under{' '}
                <Link to="/taxes/payroll">Taxes → Payroll tax</Link>. Payroll asks for confirmation while any are unverified.
              </div>
            ) : (
              <div className="alert alert-success small">All {cfg.payroll_tables.count} tables for {cfg.payroll_tables.year} are verified.</div>
            )}
            <p className="muted small">
              New employees are withheld from their W-4 details. Add a state table under Taxes → Payroll tax for each state with income tax where you have employees.
            </p>
            <h3 className="form-section">Sales tax</h3>
            <p className="muted small">
              US sales tax rates vary by state, county and city, so they aren't built in. Enter yours under{' '}
              <Link to="/taxes?tab=setup">Rates &amp; codes</Link>, or choose a third-party service (C) to calculate them automatically.
            </p>
            <div className="form-grid">
              {salesDefaults}
              {inclusive}
            </div>
          </>
        )}

        {form.method === 'stripe_tax' && (
          <>
            <h3 className="form-section">Stripe Tax</h3>
            {!cfg.stripe_connected ? (
              <div className="alert alert-warn small">
                Connect your Stripe account under <a href="#online-payments">Online payments</a> first, then save this method.
              </div>
            ) : (
              <p className="muted small">
                Uses your connected Stripe account. Turn on Stripe Tax and add your tax registrations in the Stripe Dashboard. Customers need a country and postal code
                in their address. Stripe charges per calculation, so tax is calculated when you save or click <em>Calculate tax</em>.
              </p>
            )}
            <div className="form-grid">
              <Field label="Default product tax code" hint="e.g. txcd_10000000 (general services). Products can override it.">
                <input value={form.stripe_default_tax_code} onChange={(e) => set('stripe_default_tax_code', e.target.value)} placeholder="txcd_…" />
              </Field>
              <Field label="Default tax code for purchases" hint="Stripe Tax covers sales; reclaimable VAT/GST on purchases still uses your codes">
                <CodeSelect value={form.default_purchase_tax_code_id} onChange={(v) => set('default_purchase_tax_code_id', v)} codes={cfg.codes} purchase />
              </Field>
              {inclusive}
            </div>
            <h3 className="form-section">Payroll</h3>
            <p className="muted small">Stripe doesn't calculate payroll taxes. Choose how new employees are withheld:</p>
            <div className="form-grid">
              <Field label="Payroll withholding">
                <select value={form.payroll_default} onChange={(e) => set('payroll_default', e.target.value)}>
                  <option value="percent">Fixed percentages per employee</option>
                  <option value="tables">US tax tables and W-4 (unverified)</option>
                </select>
              </Field>
            </div>
          </>
        )}

        {mismatched > 0 && (
          <label className="checkbox" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={applyToEmployees} onChange={(e) => setApplyToEmployees(e.target.checked)} /> Also switch {mismatched} existing employee
            {mismatched === 1 ? '' : 's'} to {payrollTarget === 'tables' ? 'the tax tables' : 'fixed percentages'}
          </label>
        )}
      </div>

      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy || (form.method === 'stripe_tax' && !cfg.stripe_connected)}>
          {busy ? 'Saving…' : 'Save tax calculation'}
        </button>
      </div>
    </form>
  );
}
