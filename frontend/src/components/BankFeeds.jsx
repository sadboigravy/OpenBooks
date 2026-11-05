import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, del, fmtDate, money, post, put, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, ErrorBanner, Field, Loading, Modal, isPayFromAccount } from './ui.jsx';

export const PROVIDER_NAMES = { simplefin: 'SimpleFIN', plaid: 'Plaid', gocardless: 'GoCardless' };

// Countries GoCardless Bank Account Data covers (UK + EEA)
const GC_COUNTRIES = [
  ['GB', 'United Kingdom'], ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'], ['CY', 'Cyprus'], ['CZ', 'Czechia'],
  ['DK', 'Denmark'], ['EE', 'Estonia'], ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'], ['HU', 'Hungary'],
  ['IS', 'Iceland'], ['IE', 'Ireland'], ['IT', 'Italy'], ['LV', 'Latvia'], ['LI', 'Liechtenstein'], ['LT', 'Lithuania'], ['LU', 'Luxembourg'],
  ['MT', 'Malta'], ['NL', 'Netherlands'], ['NO', 'Norway'], ['PL', 'Poland'], ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'],
  ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'],
];

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadPlaid() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLAID_SCRIPT;
    s.onload = () => resolve(window.Plaid);
    s.onerror = () => reject(new Error('Could not load Plaid Link. Check your internet connection or ad blocker.'));
    document.head.appendChild(s);
  });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return fmtDate(iso.slice(0, 10));
}

function SimpleFinPanel({ onConnected }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onConnected(await post('/bank-feeds/connections', { provider: 'simplefin', setup_token: token.trim() }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <form id="connect-form" onSubmit={connect}>
      <ErrorBanner error={error} />
      <ol className="setup-steps muted small">
        <li>
          Sign up at <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noreferrer">SimpleFIN Bridge</a> (a small yearly fee, paid to them) and connect your bank
          there.
        </li>
        <li>In SimpleFIN, choose <strong>New connection</strong> and copy the setup token.</li>
        <li>Paste it below. The token works once; OpenBooks exchanges it for read-only access.</li>
      </ol>
      <Field label="SimpleFIN setup token">
        <textarea rows={3} value={token} onChange={(e) => setToken(e.target.value)} placeholder="aHR0cHM6Ly9…" spellCheck="false" autoComplete="off" required />
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy || !token.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function PlaidPanel({ onConnected }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    setError(null);
    try {
      const [{ link_token }, Plaid] = await Promise.all([post('/bank-feeds/plaid/link-token'), loadPlaid()]);
      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (publicToken, metadata) => {
          try {
            onConnected(await post('/bank-feeds/connections', { provider: 'plaid', public_token: publicToken, institution: metadata?.institution?.name || '' }));
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        },
        onExit: (err) => {
          if (err) setError(new Error(err.display_message || err.error_message || 'Plaid Link closed with an error'));
          setBusy(false);
        },
      });
      handler.open();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div>
      <ErrorBanner error={error} />
      <p className="muted small">
        Plaid opens a secure window where you search for your bank and sign in. OpenBooks never sees your bank password; it receives read-only access to transactions.
      </p>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={open} disabled={busy}>
          {busy ? 'Opening Plaid…' : 'Choose your bank'}
        </button>
      </div>
    </div>
  );
}

function GoCardlessPanel() {
  const [country, setCountry] = useState('GB');
  const [banks, setBanks] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBanks(null);
    setError(null);
    api(`/bank-feeds/gocardless/institutions?country=${country}`).then(setBanks).catch(setError);
  }, [country]);
  const shown = useMemo(() => (banks || []).filter((b) => b.name.toLowerCase().includes(query.toLowerCase())).slice(0, 60), [banks, query]);
  async function choose(bank) {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/bank-feeds/gocardless/start', { institution_id: bank.id, institution_name: bank.name });
      window.location.assign(r.link);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div>
      <ErrorBanner error={error} />
      <p className="muted small">You'll be sent to your bank's website to approve read-only access, then brought back here.</p>
      <div className="form-grid">
        <Field label="Country">
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {GC_COUNTRIES.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search banks">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Bank name" />
        </Field>
      </div>
      {!banks && !error ? (
        <Loading />
      ) : (
        <div className="bank-picker">
          {shown.map((b) => (
            <button key={b.id} type="button" className="bank-picker-item" onClick={() => choose(b)} disabled={busy}>
              {b.logo ? <img src={b.logo} alt="" /> : <span className="bank-picker-blank" />}
              <span>{b.name}</span>
            </button>
          ))}
          {banks && shown.length === 0 && <p className="muted small">No banks match.</p>}
        </div>
      )}
    </div>
  );
}

/** Choose a provider and connect a bank. */
export function ConnectBankModal({ onClose, onConnected }) {
  const { user } = useApp();
  const cfg = useApi('/bank-feeds/config');
  const [provider, setProvider] = useState(null);
  const providers = cfg.data?.providers;
  const options = [
    ['simplefin', 'SimpleFIN Bridge', 'United States · you bring a setup token, no developer account needed'],
    ['plaid', 'Plaid', 'US, Canada, UK and Europe · uses this server\'s Plaid keys'],
    ['gocardless', 'GoCardless Bank Account Data', 'UK and Europe (open banking) · uses this server\'s GoCardless keys'],
  ];
  return (
    <Modal title="Connect a bank" onClose={onClose} wide>
      {cfg.loading && !cfg.data ? (
        <Loading />
      ) : cfg.error ? (
        <ErrorBanner error={cfg.error} />
      ) : !provider ? (
        <div className="provider-list">
          {options.map(([id, name, desc]) => {
            const ready = providers[id]?.configured;
            return (
              <button key={id} type="button" className="provider-option" disabled={!ready} onClick={() => setProvider(id)}>
                <div>
                  <strong>{name}</strong>
                  <div className="muted small">{desc}</div>
                </div>
                {ready ? (
                  <span className="badge badge-green">Available</span>
                ) : (
                  <span className="badge badge-gray">Needs setup</span>
                )}
              </button>
            );
          })}
          {(!providers.plaid.configured || !providers.gocardless.configured) && (
            <p className="muted small">
              Plaid and GoCardless need this server's own developer keys.{' '}
              {user.role === 'admin' ? (
                <Link to="/settings#bank-connections" onClick={onClose}>
                  Add them in Settings → Bank connections
                </Link>
              ) : (
                'Ask an administrator to add them in Settings → Bank connections.'
              )}
            </p>
          )}
        </div>
      ) : (
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setProvider(null)} style={{ marginBottom: 12 }}>
            ← All providers
          </button>
          {provider === 'simplefin' && <SimpleFinPanel onConnected={onConnected} />}
          {provider === 'plaid' && <PlaidPanel onConnected={onConnected} />}
          {provider === 'gocardless' && <GoCardlessPanel />}
        </>
      )}
    </Modal>
  );
}

function LinkedAccountRow({ la, isAdmin, onSaved }) {
  const { notify } = useApp();
  const [accountId, setAccountId] = useState(la.account_id || '');
  const [from, setFrom] = useState(la.sync_from || today(-30));
  const dirty = String(accountId || '') !== String(la.account_id || '') || from !== la.sync_from;
  async function save() {
    try {
      await put(`/bank-feeds/accounts/${la.id}`, { account_id: accountId || null, sync_from: from });
      notify(accountId ? 'Account linked' : 'Account unlinked');
      onSaved();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
  return (
    <tr>
      <td>
        <div>{la.name}</div>
        <small className="muted">
          {la.mask ? `•••• ${la.mask}` : ''}
          {la.mask && la.currency ? ' · ' : ''}
          {la.currency}
        </small>
      </td>
      <td className="num hide-sm">{la.balance == null ? '—' : money(la.balance)}</td>
      <td style={{ minWidth: 200 }}>
        {isAdmin ? (
          <AccountSelect value={accountId} onChange={setAccountId} filter={isPayFromAccount} placeholder="Don't import" />
        ) : (
          la.account || <span className="muted">Not imported</span>
        )}
      </td>
      <td className="hide-sm">{isAdmin ? <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Import from" /> : fmtDate(la.sync_from)}</td>
      <td className="row-actions">
        {isAdmin && dirty && (
          <button type="button" className="btn btn-sm btn-primary" onClick={save}>
            Save
          </button>
        )}
      </td>
    </tr>
  );
}

/** Banking → connected banks with account mapping and sync. */
export function BankConnections({ connections, reload, onSynced }) {
  const { user, canEdit, notify } = useApp();
  const isAdmin = user.role === 'admin';
  const [busy, setBusy] = useState(null);
  async function sync(conn) {
    setBusy(conn.id);
    try {
      const r = await post(`/bank-feeds/connections/${conn.id}/sync`);
      notify(r.imported ? `Imported ${r.imported} new transaction${r.imported === 1 ? '' : 's'} from ${conn.institution}` : `${conn.institution} is up to date`);
      onSynced();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(null);
      reload();
    }
  }
  async function disconnect(conn) {
    if (!window.confirm(`Disconnect ${conn.institution}? Transactions already imported stay in OpenBooks.`)) return;
    try {
      await del(`/bank-feeds/connections/${conn.id}`);
      notify('Bank disconnected');
      reload();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
  return connections.map((c) => {
    const unmapped = c.accounts.filter((a) => !a.account_id).length;
    return (
      <div className="card bank-connection" key={c.id}>
        <div className="card-header">
          <div>
            <h2>
              {c.institution} <span className="badge badge-gray">{PROVIDER_NAMES[c.provider]}</span>{' '}
              {c.status === 'error' ? <span className="badge badge-red">Needs attention</span> : <span className="badge badge-green">Connected</span>}
            </h2>
            <div className="muted small">
              Last synced {timeAgo(c.last_synced_at)}
              {unmapped === c.accounts.length && c.accounts.length > 0 && ' · choose which OpenBooks account each bank account imports into'}
            </div>
          </div>
          <div className="header-actions">
            {canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => sync(c)} disabled={busy === c.id}>
                {busy === c.id ? 'Syncing…' : 'Sync now'}
              </button>
            )}
            {isAdmin && (
              <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => disconnect(c)}>
                Disconnect
              </button>
            )}
          </div>
        </div>
        {c.last_error && <div className="alert alert-error">{c.last_error}</div>}
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Bank account</th>
                <th className="num hide-sm">Bank balance</th>
                <th>Import into</th>
                <th className="hide-sm">Import from</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.accounts.map((a) => (
                <LinkedAccountRow key={`${a.id}-${a.account_id}-${a.sync_from}`} la={a} isAdmin={isAdmin} onSaved={reload} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  });
}

/** Return page after approving access at a GoCardless bank. */
export function BankConnectCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useApp();
  const [error, setError] = useState(null);
  useEffect(() => {
    const id = params.get('connection');
    if (!id) {
      navigate('/banking', { replace: true });
      return;
    }
    post(`/bank-feeds/connections/${id}/finish`)
      .then((c) => {
        notify(`${c.institution} connected. Choose where each account imports.`);
        navigate('/banking?connections=1', { replace: true });
      })
      .catch(setError);
  }, []);
  return (
    <div className="card">
      {error ? (
        <>
          <ErrorBanner error={error} />
          <Link className="btn" to="/banking">
            Back to Banking
          </Link>
        </>
      ) : (
        <Loading />
      )}
    </div>
  );
}

/** Settings → Bank connections: the host's own provider credentials. */
export function BankFeedSettings() {
  const { notify } = useApp();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api('/bank-feeds/config').then((c) => {
      setCfg(c);
      setForm({ ...c.settings, plaid_secret: '', gocardless_secret_key: '', sync_hours: c.sync_hours });
    });
  useEffect(() => {
    load().catch(setError);
  }, []);
  if (error && !cfg) return <ErrorBanner error={error} />;
  if (!cfg || !form) return <Loading />;
  const env = new Set(cfg.settings.from_env);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = { ...form };
    delete payload.from_env;
    for (const k of ['plaid_secret', 'gocardless_secret_key']) if (!payload[k]) delete payload[k];
    for (const k of env) delete payload[k];
    try {
      await put('/bank-feeds/config', payload);
      await load();
      notify('Bank connection settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function clearSecret(key) {
    if (!window.confirm('Remove this saved secret?')) return;
    await put('/bank-feeds/config', { [key]: '' });
    await load();
  }
  const secretHint = (key, fallback) =>
    env.has(key) ? (
      <span className="badge badge-blue">Set by environment variable</span>
    ) : cfg.settings[key] ? (
      <span className="secret-saved">
        <span className="badge badge-green">Saved {cfg.settings[key]}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => clearSecret(key)}>
          Remove
        </button>
      </span>
    ) : (
      fallback
    );
  const envHint = (key, fallback) => (env.has(key) ? 'Set by environment variable' : fallback);
  return (
    <form className="card form-card" onSubmit={save} id="bank-connections">
      <div className="card-header">
        <div>
          <h2>Bank connections</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Pull transactions straight from your bank into Banking → For review. Use your <strong>own</strong> provider accounts; bank access is read-only and stored
            encrypted on this server.
          </p>
        </div>
        <Link className="btn btn-sm" to="/banking?connect=1">
          Connect a bank
        </Link>
      </div>
      <ErrorBanner error={error} />

      <h3 className="form-section">SimpleFIN Bridge · United States</h3>
      <p className="muted small">No setup needed here. Each user brings a SimpleFIN setup token when connecting.</p>

      <h3 className="form-section">
        Plaid · US, Canada, UK, Europe{' '}
        {cfg.providers.plaid.configured ? <span className="badge badge-green">Ready</span> : <span className="badge badge-gray">Not set up</span>}
      </h3>
      <p className="muted small">
        Create an app at dashboard.plaid.com, enable the Transactions product, and copy the client ID and the secret for the environment you use. Sandbox works with Plaid's
        test banks; production needs Plaid's approval.
      </p>
      <div className="form-grid">
        <Field label="Client ID" hint={envHint('plaid_client_id')}>
          <input value={form.plaid_client_id} onChange={set('plaid_client_id')} disabled={env.has('plaid_client_id')} autoComplete="off" spellCheck="false" />
        </Field>
        <Field label="Secret" hint={secretHint('plaid_secret', 'Stored encrypted, never shown again')}>
          <input type="password" value={form.plaid_secret} onChange={set('plaid_secret')} disabled={env.has('plaid_secret')} placeholder={cfg.settings.plaid_secret ? 'Enter a new secret to replace it' : ''} autoComplete="new-password" />
        </Field>
        <Field label="Environment" hint={envHint('plaid_env')}>
          <select value={form.plaid_env} onChange={set('plaid_env')} disabled={env.has('plaid_env')}>
            <option value="sandbox">Sandbox (test banks)</option>
            <option value="production">Production</option>
          </select>
        </Field>
        <Field label="Countries" hint="2-letter codes Plaid Link offers, e.g. US, CA, GB, FR">
          <input value={form.plaid_countries} onChange={set('plaid_countries')} />
        </Field>
      </div>

      <h3 className="form-section">
        GoCardless Bank Account Data · UK and Europe{' '}
        {cfg.providers.gocardless.configured ? <span className="badge badge-green">Ready</span> : <span className="badge badge-gray">Not set up</span>}
      </h3>
      <p className="muted small">In the GoCardless Bank Account Data portal, open User secrets and create a secret ID and key.</p>
      <div className="form-grid">
        <Field label="Secret ID" hint={envHint('gocardless_secret_id')}>
          <input value={form.gocardless_secret_id} onChange={set('gocardless_secret_id')} disabled={env.has('gocardless_secret_id')} autoComplete="off" spellCheck="false" />
        </Field>
        <Field label="Secret key" hint={secretHint('gocardless_secret_key', 'Stored encrypted, never shown again')}>
          <input type="password" value={form.gocardless_secret_key} onChange={set('gocardless_secret_key')} disabled={env.has('gocardless_secret_key')} placeholder={cfg.settings.gocardless_secret_key ? 'Enter a new key to replace it' : ''} autoComplete="new-password" />
        </Field>
      </div>

      <h3 className="form-section">Automatic sync</h3>
      <div className="form-grid">
        <Field label="Sync every (hours)" hint="0 turns automatic sync off; you can still press Sync now">
          <input type="number" min="0" max="168" step="1" value={form.sync_hours} onChange={set('sync_hours')} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          Save bank connections
        </button>
      </div>
    </form>
  );
}
