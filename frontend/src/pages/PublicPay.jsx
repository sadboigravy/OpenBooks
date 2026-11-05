// Customer-facing invoice payment page. Reached at /pay/<token> without signing in.
import { useEffect, useState } from 'react';
import { api, fmtDate, money, post, setCurrency } from '../lib.jsx';

export default function PublicPay() {
  const token = window.location.pathname.split('/')[2] || '';
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const canceled = params.get('canceled');
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(canceled ? 'Payment was cancelled. You can try again whenever you are ready.' : null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await api(`/public/invoices/${token}`);
      setCurrency(data.currency);
      setInv(data);
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    (async () => {
      if (sessionId) {
        try {
          const r = await post(`/public/invoices/${token}/confirm`, { session_id: sessionId });
          setNotice(r.paid ? 'Thank you — your payment was received.' : 'Your payment is processing. This page will show it once Stripe confirms it.');
        } catch (err) {
          setNotice(null);
          setError(err);
        }
        window.history.replaceState(null, '', `/pay/${token}`);
      }
      load();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await post(`/public/invoices/${token}/checkout`, {});
      window.location.assign(url);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="pay-page">
      <div className="pay-card">
        {!inv && !error && <div className="loading">Loading invoice…</div>}
        {error && !inv && (
          <div className="pay-error">
            <h1>Payment link unavailable</h1>
            <p className="muted">{error.message}</p>
          </div>
        )}
        {inv && (
          <>
            <div className="pay-head">
              <div>
                <div className="muted small">Invoice from</div>
                <h1>{inv.company.name}</h1>
                <div className="muted small pre">{[inv.company.email, inv.company.phone].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="pay-amount">
                <div className="muted small">{inv.balance > 0 ? 'Amount due' : 'Balance'}</div>
                <div className="pay-total">{money(inv.balance)}</div>
                {inv.balance > 0 && <div className="muted small">Due {fmtDate(inv.due_date)}</div>}
              </div>
            </div>
            {notice && <div className={`alert ${notice.startsWith('Thank') ? 'alert-success' : 'alert-info'}`}>{notice}</div>}
            {error && <div className="alert alert-error">{error.message}</div>}
            <div className="pay-meta">
              <span>
                Invoice <strong>{inv.number}</strong>
              </span>
              <span>
                Billed to <strong>{inv.customer}</strong>
              </span>
              <span>Issued {fmtDate(inv.date)}</span>
            </div>
            <table className="table compact">
              <tbody>
                {inv.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.description}
                      {l.quantity !== 1 && (
                        <span className="muted small">
                          {' '}
                          × {l.quantity} @ {money(l.unit_price)}
                        </span>
                      )}
                    </td>
                    <td className="num">{money(l.amount)}</td>
                  </tr>
                ))}
                {inv.tax > 0 && (
                  <tr>
                    <td className="muted">Tax</td>
                    <td className="num">{money(inv.tax)}</td>
                  </tr>
                )}
                <tr className="strong">
                  <td>Total</td>
                  <td className="num">{money(inv.total)}</td>
                </tr>
                {inv.paid > 0 && (
                  <tr>
                    <td className="muted">Paid</td>
                    <td className="num">−{money(inv.paid)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {inv.memo && <p className="muted small pre">{inv.memo}</p>}
            {inv.balance <= 0 ? (
              <div className="pay-done">✓ This invoice is paid in full</div>
            ) : inv.can_pay ? (
              <button type="button" className="btn btn-primary btn-block pay-btn" onClick={pay} disabled={busy}>
                {busy ? 'Opening secure checkout…' : `Pay ${money(inv.balance)}`}
              </button>
            ) : (
              <p className="muted">Online payment isn't available for this invoice. Please contact {inv.company.name} to pay.</p>
            )}
            {inv.can_pay && inv.balance > 0 && <p className="pay-secure muted small">Payments are processed securely by Stripe. Card details never touch this site.</p>}
          </>
        )}
      </div>
      <div className="pay-foot muted small">
        <img src="/logo-mark.svg" alt="" width="16" height="16" /> Powered by OpenBooks
      </div>
    </div>
  );
}
