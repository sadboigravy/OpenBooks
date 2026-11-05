import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, fmtDate, money, post, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Loading, PageHeader, StatusBadge } from '../components/ui.jsx';
import PaymentModal from '../components/PaymentModal.jsx';

export default function BillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, notify } = useApp();
  const { data: bill, error, loading, reload } = useApi(`/bills/${id}`);
  const [paying, setPaying] = useState(false);
  const [actionError, setActionError] = useState(null);

  if (loading && !bill) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  async function run(fn, message, after) {
    setActionError(null);
    try {
      await fn();
      notify(message);
      after ? after() : reload();
    } catch (err) {
      setActionError(err);
    }
  }
  const open = ['open', 'partial', 'overdue'].includes(bill.status);

  return (
    <>
      <PageHeader title={`Bill from ${bill.vendor}`} subtitle={<StatusBadge status={bill.status} />}>
        <Link className="btn btn-ghost" to="/bills">
          ← Bills
        </Link>
        {canEdit && bill.status !== 'void' && (
          <Link className="btn" to={`/bills/${bill.id}/edit`}>
            Edit
          </Link>
        )}
        {canEdit && open && (
          <>
            <button className="btn" onClick={() => setPaying(true)}>
              Quick pay
            </button>
            <Link className="btn btn-primary" to={`/pay-bills?bill_id=${bill.id}`}>
              Pay bill
            </Link>
          </>
        )}
      </PageHeader>
      <ErrorBanner error={actionError} />
      <div className="card">
        <div className="detail-grid">
          <div>
            <div className="field-label">Vendor</div>
            <strong>{bill.vendor}</strong>
            <div className="muted">{bill.vendor_detail.email}</div>
          </div>
          <div>
            <div className="field-label">Bill #</div>
            {bill.number || '—'}
          </div>
          <div>
            <div className="field-label">Bill date</div>
            {fmtDate(bill.date)}
          </div>
          <div>
            <div className="field-label">Due date</div>
            {fmtDate(bill.due_date)}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Description</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.account}</td>
                <td>{l.description}</td>
                <td className="num">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-bottom">
          <div className="grow pre muted">{bill.memo}</div>
          <div className="totals">
            <div className="grand">
              <span>Total</span>
              <span>{money(bill.total)}</span>
            </div>
            <div>
              <span>Paid</span>
              <span>{money(bill.paid)}</span>
            </div>
            <div className="grand">
              <span>Balance due</span>
              <span>{money(bill.balance)}</span>
            </div>
          </div>
        </div>
      </div>

      {bill.payments.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>Payments</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Paid from</th>
                <th className="hide-sm">Method</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bill.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td>
                  <td>{p.account}</td>
                  <td className="hide-sm">
                    {p.method} {p.reference && `#${p.reference}`}
                  </td>
                  <td className="num">{money(p.amount)}</td>
                  <td className="row-actions">
                    {canEdit && (
                      <button className="btn btn-sm btn-danger-ghost" onClick={() => window.confirm('Delete this payment?') && run(() => del(`/payments/${p.id}`), 'Payment deleted')}>
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

      {canEdit && (
        <div className="danger-zone">
          {bill.status !== 'void' && (
            <button className="btn btn-danger-ghost" onClick={() => window.confirm('Void this bill?') && run(() => post(`/bills/${bill.id}/void`), 'Bill voided')}>
              Void bill
            </button>
          )}
          <button
            className="btn btn-danger-ghost"
            onClick={() => window.confirm('Permanently delete this bill?') && run(() => del(`/bills/${bill.id}`), 'Bill deleted', () => navigate('/bills'))}
          >
            Delete bill
          </button>
        </div>
      )}

      {paying && (
        <PaymentModal
          doc={bill}
          kind="bill"
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            reload();
          }}
        />
      )}
    </>
  );
}
