import { useState } from 'react';
import { post } from '../lib.jsx';

/** Shown after signing in with the built-in first-run login. */
export default function SetupAdmin({ onDone, onSignOut }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError('The passwords do not match');
      return;
    }
    setBusy(true);
    try {
      onDone(await post('/auth/setup-admin', form));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card setup-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/logo-mark.svg" alt="" width="48" height="48" />
          <div>
            <h1 className="wordmark">
              Open<span className="brand-accent">Books</span>
            </h1>
            <p className="muted">Create your administrator account</p>
          </div>
        </div>
        <div className="alert alert-info small">
          You signed in with the built-in first-run login. Create your own administrator account to continue. The default login will then be deleted and can't be used again.
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span className="field-label">Your name</span>
          <input value={form.name} onChange={set('name')} autoComplete="name" required autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Email (you'll sign in with this)</span>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={10} required />
          <span className="field-hint">At least 10 characters. A short phrase is easier to remember and harder to guess.</span>
        </label>
        <label className="field">
          <span className="field-label">Confirm password</span>
          <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account and continue'}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onSignOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}
