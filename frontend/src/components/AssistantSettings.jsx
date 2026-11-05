import { useEffect, useState } from 'react';
import { api, post, put, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Loading } from './ui.jsx';

/** Settings → AI assistant. Each OpenBooks instance uses its own Anthropic API key. */
export default function AssistantSettings() {
  const { notify, refreshSettings } = useApp();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);

  const load = () =>
    api('/assistant/config').then((c) => {
      setCfg(c);
      setForm({ api_key: '', model: c.model, effort: c.effort, enabled: c.enabled });
    });
  useEffect(() => {
    load().catch(setError);
  }, []);

  if (error && !cfg) return <ErrorBanner error={error} />;
  if (!cfg || !form) return <Loading />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      await put('/assistant/config', form);
      await Promise.all([load(), refreshSettings()]);
      notify('AI assistant settings saved');
    } catch (err) {
      setError(err);
    }
  }
  async function runTest() {
    setTest({ busy: true });
    try {
      setTest(await post('/assistant/test'));
    } catch (err) {
      setTest({ error: err.message });
    }
  }
  async function removeKey() {
    if (!window.confirm('Remove the saved API key and turn the assistant off?')) return;
    await put('/assistant/config', { clear_api_key: true });
    await Promise.all([load(), refreshSettings()]);
  }

  return (
    <form className="card form-card" onSubmit={save} id="assistant">
      <div className="card-header">
        <div>
          <h2>AI assistant (Claude)</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Ask questions about your books in plain English. Uses <strong>your own</strong> Anthropic API key; usage is billed to your Anthropic account.
          </p>
        </div>
        {cfg.ready ? <span className="badge badge-green">Active</span> : <span className="badge badge-gray">Off</span>}
      </div>
      <ErrorBanner error={error} />
      <div className="alert alert-info small">
        When someone asks a question, the relevant figures from your books (for example report totals, invoice and customer details) are sent to Anthropic
        to generate the answer. The assistant can only read data; it cannot create, change or delete anything.
      </div>
      <div className="form-grid">
        <Field
          label="Anthropic API key"
          hint={
            cfg.api_key_from_environment ? (
              <span className="badge badge-blue">Set by ANTHROPIC_API_KEY environment variable</span>
            ) : cfg.api_key_saved ? (
              <span className="secret-saved">
                <span className="badge badge-green">Saved {cfg.api_key_saved}</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={removeKey}>
                  Remove
                </button>
              </span>
            ) : (
              <>
                Create one at <strong>console.anthropic.com</strong> → API keys. Stored on your server and never shown again.
              </>
            )
          }
        >
          <input type="password" value={form.api_key} onChange={set('api_key')} disabled={cfg.api_key_from_environment} placeholder={cfg.api_key_saved ? 'Enter a new key to replace it' : 'sk-ant-…'} autoComplete="new-password" />
        </Field>
        <Field label="Model">
          <select value={form.model} onChange={set('model')}>
            {Object.entries(cfg.models).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Effort" hint="Higher effort gives more thorough answers but is slower and uses more tokens">
          <select value={form.effort} onChange={set('effort')}>
            <option value="low">Low — quickest</option>
            <option value="medium">Medium — balanced</option>
            <option value="high">High — most thorough</option>
          </select>
        </Field>
      </div>
      <label className="checkbox" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> Turn on the AI assistant for everyone in this company
      </label>
      {test && !test.busy && (
        <div className={`alert ${test.ok ? 'alert-success' : 'alert-error'}`} style={{ marginTop: 12 }}>
          {test.ok ? `Connected — ${test.model} responded.` : test.error}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={runTest} disabled={!cfg.api_key_saved}>
          {test?.busy ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn btn-primary">Save assistant settings</button>
      </div>
    </form>
  );
}
