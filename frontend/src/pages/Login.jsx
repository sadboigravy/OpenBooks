import { useEffect, useState } from 'react';
import { api, post } from '../lib.jsx';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    api('/auth/status')
      .then((s) => setFirstRun(s.first_run))
      .catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await post('/auth/login', { email, password }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/logo-mark.svg" alt="" width="48" height="48" />
          <div>
            <h1 className="wordmark">
              Open<span className="brand-accent">Books</span>
            </h1>
            <p className="muted">Sign in to your books</p>
          </div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {firstRun && (
        <p className="login-hint muted">
          First time? Sign in with <code>admin@openbooks.local</code> / <code>openbooks</code>. You'll be asked to create your own administrator account, and that
          default login is then removed.
        </p>
        )}
      </form>
    </div>
  );
}
