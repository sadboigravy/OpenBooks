import { useState } from 'react';
import { Modal } from '../components/ui.jsx';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { KIND_INFO, del, fmtDate, money, post, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Loading, PageHeader, StatusBadge } from '../components/ui.jsx';
import PaymentModal from '../components/PaymentModal.jsx';

const BILL_TO = { invoice: 'Bill to', estimate: 'Prepared for', sales_receipt: 'Sold to' };

export default function SalesView({ kind }) {
  const info = KIND_INFO[kind];
  const { id } = useParams();
  const navigate = useNavigate();
  const { settings, canEdit, notify } = useApp();
  const { data: doc, error, loading, reload } = useApi(`/invoices/${id}`);
  const [paying, setPaying] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [payLink, setPayLink] = useState(null);

  if (loading && !doc) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (String(doc.id) !== String(id)) return <Loading />; // previous document still showing while the new one loads
  if (doc.kind !== kind) {
    navigate(`${KIND_INFO[doc.kind].path}/${doc.id}`, { replace: true });
    return null;
  }

  async function run(fn, message) {
    setActionError(null);
    try {
      await fn();
      if (message) notify(message);
      reload();
    } catch (err) {
      setActionError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Permanently delete this ${info.label.toLowerCase()}?`)) return;
    try {
      await del(`/invoices/${doc.id}`);
      notify(`${info.label} deleted`);
      navigate(info.path);
    } catch (err) {
      setActionError(err);
    }
  }

  const unpaid = kind === 'invoice' && ['open', 'partial', 'overdue'].includes(doc.status);
  const editable = !['void', 'closed'].includes(doc.status);
  const estimateOpen = kind === 'estimate' && ['pending', 'accepted', 'expired'].includes(doc.status);
  const canVoid = kind !== 'estimate' && !['void', 'draft'].includes(doc.status);
  const canDelete = kind === 'estimate' || ['void', 'draft'].includes(doc.status);

  return (
    <>
      <PageHeader title={`${info.label} ${doc.number}`} subtitle={<StatusBadge status={doc.status} />}>
        <Link className="btn btn-ghost" to={info.path}>
          ← {info.plural}
        </Link>
        <button className="btn" onClick={() => window.print()}>
          Print / PDF
        </button>
        {canEdit && editable && (
          <Link className="btn" to={`${info.path}/${doc.id}/edit`}>
            Edit
          </Link>
        )}
        {canEdit && estimateOpen && doc.status !== 'accepted' && (
          <button className="btn" onClick={() => run(() => post(`/invoices/${doc.id}/status`, { status: 'accepted' }), 'Estimate accepted')}>
            Mark accepted
          </button>
        )}
        {canEdit && estimateOpen && (
          <Link className="btn btn-primary" to={`/invoices/new?from_estimate=${doc.id}`}>
            Create invoice
          </Link>
        )}
        {canEdit && unpaid && settings.online_payments_enabled && (
          <button
            className="btn"
            onClick={async () => {
              try {
                setPayLink((await post(`/invoices/${doc.id}/payment-link`)).url);
              } catch (err) {
                setActionError(err);
              }
            }}
          >
            Share payment link
          </button>
        )}
        {canEdit && unpaid && (
          <button className="btn btn-primary" onClick={() => setPaying(true)}>
            Receive payment
          </button>
        )}
        {canEdit && doc.status === 'draft' && (
          <Link className="btn btn-primary" to={`/invoices/${doc.id}/edit`}>
            Finalise
          </Link>
        )}
      </PageHeader>
      <ErrorBanner error={actionError} />
      {kind === 'estimate' && doc.status === 'closed' && doc.estimate_id && (
        <div className="alert alert-info no-print">
          This estimate was converted to an invoice. <Link to={`/invoices/${doc.estimate_id}`}>Open the invoice →</Link>
        </div>
      )}
      {kind === 'invoice' && doc.estimate_id && (
        <div className="alert alert-info no-print">
          Created from <Link to={`/estimates/${doc.estimate_id}`}>an estimate</Link>.
        </div>
      )}

      <div className="card invoice-doc">
        <div className="doc-head">
          <div>
            <h2 className="doc-company">{settings.company_name}</h2>
            <div className="pre muted">{settings.company_address}</div>
            <div className="muted">{[settings.company_email, settings.company_phone].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="doc-title">
            <div className="doc-label">{info.label.toUpperCase()}</div>
            <table className="doc-meta">
              <tbody>
                <tr>
                  <th>{info.label} #</th>
                  <td>{doc.number}</td>
                </tr>
                <tr>
                  <th>Date</th>
                  <td>{fmtDate(doc.date)}</td>
                </tr>
                {kind !== 'sales_receipt' && (
                  <tr>
                    <th>{kind === 'estimate' ? 'Expires' : 'Due'}</th>
                    <td>{fmtDate(doc.due_date)}</td>
                  </tr>
                )}
                {kind === 'sales_receipt' && doc.method && (
                  <tr>
                    <th>Paid by</th>
                    <td>{doc.method}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="doc-billto">
          <div className="doc-label-sm">{BILL_TO[kind]}</div>
          <strong>{doc.customer_detail.name}</strong>
          {doc.customer_detail.company && <div>{doc.customer_detail.company}</div>}
          <div className="pre">{doc.customer_detail.address}</div>
          <div className="muted">{doc.customer_detail.email}</div>
        </div>
        <table className="table doc-lines">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Rate</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.item && <strong className="doc-item">{l.item}</strong>}
                  {l.description || (!l.item && <span className="muted">{l.account}</span>)}
                  {l.tax_code && doc.tax > 0 && <small className="muted"> · {l.tax_code}</small>}
                </td>
                <td className="num">{l.quantity}</td>
                <td className="num">{money(l.unit_price)}</td>
                <td className="num">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-bottom">
          <div className="grow pre">{doc.memo}</div>
          <div className="totals">
            <div>
              <span>Subtotal</span>
              <span>{money(doc.subtotal)}</span>
            </div>
            {doc.tax_details?.length > 0
              ? doc.tax_details.map((t) => (
                  <div key={t.id} className="tax-detail">
                    <span>
                      {t.name} {t.rate ? <span className="muted">({t.rate}%)</span> : null}
                    </span>
                    <span>{money(t.tax)}</span>
                  </div>
                ))
              : doc.tax > 0 && (
                  <div>
                    <span>Tax{doc.tax_rate ? ` (${doc.tax_rate}%)` : ''}</span>
                    <span>{money(doc.tax)}</span>
                  </div>
                )}
            {doc.amounts_inclusive && <div className="small muted">Amounts include tax</div>}
            {doc.customer_detail.tax_exempt && <div className="small muted">Tax exempt{doc.customer_detail.exemption_reason ? `: ${doc.customer_detail.exemption_reason}` : ''}</div>}
            <div className="grand">
              <span>Total</span>
              <span>{money(doc.total)}</span>
            </div>
            {kind === 'invoice' && doc.paid > 0 && (
              <div>
                <span>Paid</span>
                <span>−{money(doc.paid)}</span>
              </div>
            )}
            {kind === 'invoice' && (
              <div className="grand">
                <span>Balance due</span>
                <span>{money(doc.balance)}</span>
              </div>
            )}
            {kind === 'sales_receipt' && (
              <div className="grand">
                <span>Amount received</span>
                <span>{money(doc.total)}</span>
              </div>
            )}
          </div>
        </div>
        {kind === 'sales_receipt' && doc.deposit_account && <p className="muted small no-print">Deposited to {doc.deposit_account}</p>}
      </div>

      {doc.payments?.length > 0 && (
        <div className="card no-print">
          <div className="card-header">
            <h2>Payments</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Deposited to</th>
                <th className="hide-sm">Method</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {doc.payments.map((p) => (
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

      {canEdit && (canVoid || canDelete || estimateOpen) && (
        <div className="danger-zone no-print">
          {estimateOpen && (
            <button className="btn btn-danger-ghost" onClick={() => run(() => post(`/invoices/${doc.id}/status`, { status: 'rejected' }), 'Estimate rejected')}>
              Mark rejected
            </button>
          )}
          {canVoid && (
            <button
              className="btn btn-danger-ghost"
              onClick={() =>
                window.confirm(`Void this ${info.label.toLowerCase()}? It is removed from your books but kept for reference.`) &&
                run(() => post(`/invoices/${doc.id}/void`), `${info.label} voided`)
              }
            >
              Void {info.label.toLowerCase()}
            </button>
          )}
          {canDelete && (
            <button className="btn btn-danger-ghost" onClick={remove}>
              Delete {info.label.toLowerCase()}
            </button>
          )}
        </div>
      )}

      {payLink && (
        <Modal
          title="Payment link"
          onClose={() => setPayLink(null)}
          footer={
            <>
              <span className="spacer" />
              <a className="btn" href={payLink} target="_blank" rel="noreferrer">
                Open
              </a>
              <button className="btn btn-primary" onClick={() => navigator.clipboard?.writeText(payLink).then(() => notify('Link copied'))}>
                Copy link
              </button>
            </>
          }
        >
          <p className="muted">
            Send this link to {doc.customer}. They can pay {money(doc.balance)} by card through Stripe, and the payment is recorded on this invoice automatically.
          </p>
          <input readOnly value={payLink} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
      {paying && (
        <PaymentModal
          doc={doc}
          kind="invoice"
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
