import { useEffect, useState } from 'react';
import { api, post, put, useApp } from '../lib.jsx';
import { AccountSelect, ErrorBanner, Field, Loading, isBankAccount } from './ui.jsx';

/** Settings → Online payments. Each OpenBooks instance connects its own Stripe account. */
export default function StripeSettings() {
  const { notify, refreshSettings } = useApp();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/stripe/config').then((c) => {
      setCfg(c);
      setForm({ publishable_key: c.publishable_key, secret_key: '', webhook_secret: '', deposit_account_id: c.deposit_account_id || '', public_url: c.public_url, enabled: c.enabled });
    });
  useEffect(() => {
    load().catch(setError);
  }, []);

  if (error && !cfg) return <ErrorBanner error={error} />;
  if (!cfg || !form) return <Loading />;
  const env = cfg.from_environment;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await put('/stripe/config', form);
      await Promise.all([load(), refreshSettings()]);
      notify('Online payment settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function runTest() {
    setTest({ busy: true });
    try {
      setTest(await post('/stripe/test'));
    } catch (err) {
      setTest({ error: err.message });
    }
  }
  async function clear(name) {
    if (!window.confirm('Remove this saved key?')) return;
    await put('/stripe/config', { clear: [name], enabled: false });
    await Promise.all([load(), refreshSettings()]);
  }

  const savedNote = (saved, name, envKey) =>
    env[envKey] ? (
      <span className="secret-saved badge badge-blue">Set by environment variable</span>
    ) : saved ? (
      <span className="secret-saved">
        <span className="badge badge-green">Saved {saved}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => clear(name)}>
          Remove
        </button>
      </span>
    ) : null;

  return (
    <form className="card form-card" onSubmit={save} id="online-payments">
      <div className="card-header">
        <div>
          <h2>Online payments (Stripe)</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Let customers pay invoices by card from a link. Payments go to <strong>your own</strong> Stripe account and are recorded automatically.
          </p>
        </div>
        {cfg.ready ? <span className="badge badge-green">Active · {cfg.mode} mode</span> : <span className="badge badge-gray">Not active</span>}
      </div>
      <ErrorBanner error={error} />
      <ol className="setup-steps muted small">
        <li>
          In your Stripe Dashboard open <strong>Developers → API keys</strong> and copy the publishable and secret keys (use test keys first).
        </li>
        <li>
          Under <strong>Developers → Webhooks</strong>, add an endpoint for the URL below, select the <code>checkout.session.completed</code> and{' '}
          <code>checkout.session.async_payment_succeeded</code> events, and copy its signing secret.
        </li>
        <li>Choose the bank account Stripe pays out to, save, then turn online payments on.</li>
      </ol>
      <div className="form-grid">
        <Field label="Publishable key" hint={env.stripe_publishable_key ? 'Set by environment variable' : 'pk_test_… or pk_live_…'}>
          <input value={form.publishable_key} onChange={set('publishable_key')} disabled={env.stripe_publishable_key} autoComplete="off" spellCheck="false" />
        </Field>
        <Field label="Secret key" hint={savedNote(cfg.secret_key_saved, 'secret_key', 'stripe_secret_key') || 'sk_test_… — stored on your server, never shown again'}>
          <input type="password" value={form.secret_key} onChange={set('secret_key')} disabled={env.stripe_secret_key} placeholder={cfg.secret_key_saved ? 'Enter a new key to replace it' : ''} autoComplete="new-password" />
        </Field>
        <Field label="Webhook signing secret" hint={savedNote(cfg.webhook_secret_saved, 'webhook_secret', 'stripe_webhook_secret') || 'whsec_…'}>
          <input type="password" value={form.webhook_secret} onChange={set('webhook_secret')} disabled={env.stripe_webhook_secret} placeholder={cfg.webhook_secret_saved ? 'Enter a new secret to replace it' : ''} autoComplete="new-password" />
        </Field>
        <Field label="Deposit Stripe payments to" hint="Usually the bank account Stripe pays out to">
          <AccountSelect value={form.deposit_account_id} onChange={(v) => setForm({ ...form, deposit_account_id: v })} filter={isBankAccount} />
        </Field>
        <Field label="Public URL of this OpenBooks" hint={env.public_url ? 'Set by environment variable' : 'Used in payment links, e.g. https://books.yourcompany.com. Leave blank to use the address you are on now.'}>
          <input value={form.public_url} onChange={set('public_url')} disabled={env.public_url} placeholder="https://" />
        </Field>
        <Field label="Webhook endpoint URL (paste into Stripe)">
          <div className="copy-row">
            <input value={cfg.webhook_url} readOnly />
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(cfg.webhook_url).then(() => notify('Copied'))}>
              Copy
            </button>
          </div>
        </Field>
      </div>
      <label className="checkbox" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> Turn on online invoice payments
      </label>
      {test && !test.busy && (
        <div className={`alert ${test.ok ? 'alert-success' : 'alert-error'}`} style={{ marginTop: 12 }}>
          {test.ok ? `Connected to ${test.name || test.account_id} (${test.mode} mode)${test.charges_enabled ? '' : ' — charges are not yet enabled on this account'}` : test.error}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={runTest} disabled={!cfg.secret_key_saved && !env.stripe_secret_key}>
          {test?.busy ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn btn-primary" disabled={busy}>
          Save online payments
        </button>
      </div>
    </form>
  );
}
