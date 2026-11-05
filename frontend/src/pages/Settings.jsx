import { useEffect, useState } from 'react';
import { post, put, useApp } from '../lib.jsx';
import { ErrorBanner, Field, PageHeader } from '../components/ui.jsx';
import StripeSettings from '../components/StripeSettings.jsx';
import AssistantSettings from '../components/AssistantSettings.jsx';
import TaxMethodSettings from '../components/TaxMethodSettings.jsx';
import DataSettings from '../components/DataSettings.jsx';
import { BankFeedSettings } from '../components/BankFeeds.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function CompanySettings() {
  const { settings, refreshSettings, notify, user } = useApp();
  const [form, setForm] = useState(settings);
  const [error, setError] = useState(null);
  const isAdmin = user.role === 'admin';
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      await put('/settings', form);
      await refreshSettings();
      notify('Settings saved');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <form className="card form-card" onSubmit={save}>
      <div className="card-header">
        <h2>Company</h2>
        {!isAdmin && <span className="muted small">Only administrators can change these</span>}
      </div>
      <ErrorBanner error={error} />
      <fieldset disabled={!isAdmin} className="form-grid">
        <Field label="Company name *">
          <input value={form.company_name} onChange={set('company_name')} required />
        </Field>
        <Field label="Email">
          <input type="email" value={form.company_email} onChange={set('company_email')} />
        </Field>
        <Field label="Phone">
          <input value={form.company_phone} onChange={set('company_phone')} />
        </Field>
        <Field label="Currency" hint="3-letter code, e.g. USD, EUR, GBP, CAD, AUD">
          <input value={form.currency} maxLength={3} onChange={set('currency')} required />
        </Field>
        <Field label="Address (shown on invoices)" className="span-2">
          <textarea rows={3} value={form.company_address} onChange={set('company_address')} />
        </Field>
        <Field label="Fiscal year starts in">
          <select value={form.fiscal_year_start_month} onChange={set('fiscal_year_start_month')}>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Invoice number prefix">
          <input value={form.invoice_prefix} onChange={set('invoice_prefix')} />
        </Field>
        <Field label="Next invoice number">
          <input type="number" min="1" value={form.next_invoice_number} onChange={set('next_invoice_number')} />
        </Field>
        <Field label="Default payment terms (days)">
          <input type="number" min="0" value={form.default_terms_days} onChange={set('default_terms_days')} />
        </Field>
        <Field label="Estimate number prefix">
          <input value={form.estimate_prefix} onChange={set('estimate_prefix')} />
        </Field>
        <Field label="Next estimate number">
          <input type="number" min="1" value={form.next_estimate_number} onChange={set('next_estimate_number')} />
        </Field>
        <Field label="Sales receipt number prefix">
          <input value={form.receipt_prefix} onChange={set('receipt_prefix')} />
        </Field>
        <Field label="Next sales receipt number">
          <input type="number" min="1" value={form.next_receipt_number} onChange={set('next_receipt_number')} />
        </Field>
      </fieldset>
      <h3 className="form-section">Payroll tax rates</h3>
      <p className="muted small">
        Applied to every paycheck. Defaults are the current US social security and Medicare rates; change them to match your jurisdiction. Set the social
        security wage base to 0 for no cap.
      </p>
      <fieldset disabled={!isAdmin} className="form-grid cols-4">
        <Field label="Social security rate (%)" hint="Withheld from employee and matched by employer">
          <input type="number" step="0.001" min="0" value={form.payroll_ss_rate} onChange={set('payroll_ss_rate')} />
        </Field>
        <Field label="Social security wage base">
          <input type="number" step="1" min="0" value={form.payroll_ss_wage_base} onChange={set('payroll_ss_wage_base')} />
        </Field>
        <Field label="Medicare rate (%)" hint="Withheld from employee and matched by employer">
          <input type="number" step="0.001" min="0" value={form.payroll_medicare_rate} onChange={set('payroll_medicare_rate')} />
        </Field>
        <Field label="Other employer taxes (%)" hint="e.g. unemployment insurance">
          <input type="number" step="0.001" min="0" value={form.payroll_employer_extra_rate} onChange={set('payroll_employer_extra_rate')} />
        </Field>
      </fieldset>
      {isAdmin && (
        <div className="form-actions">
          <button className="btn btn-primary">Save settings</button>
        </div>
      )}
    </form>
  );
}

function ChangePassword() {
  const { notify } = useApp();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setError(null);
    if (form.new_password !== form.confirm) {
      setError(new Error('The new passwords do not match'));
      return;
    }
    try {
      await post('/auth/change-password', form);
      setForm({ current_password: '', new_password: '', confirm: '' });
      notify('Password changed');
    } catch (err) {
      setError(err);
    }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <form className="card form-card" onSubmit={save} id="password">
      <div className="card-header">
        <h2>Change your password</h2>
      </div>
      <ErrorBanner error={error} />
      <div className="form-grid cols-3">
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={form.current_password} onChange={set('current_password')} required />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <input type="password" autoComplete="new-password" minLength={8} value={form.new_password} onChange={set('new_password')} required />
        </Field>
        <Field label="Confirm new password">
          <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary">Change password</button>
      </div>
    </form>
  );
}

export default function Settings() {
  const { user } = useApp();
  const isAdmin = user.role === 'admin';
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 300);
  }, []);
  return (
    <>
      <PageHeader title="Settings" />
      <CompanySettings />
      {isAdmin && <TaxMethodSettings />}
      {isAdmin && <StripeSettings />}
      {isAdmin && <BankFeedSettings />}
      {isAdmin && <AssistantSettings />}
      <ChangePassword />
      {isAdmin && <DataSettings />}
    </>
  );
}
