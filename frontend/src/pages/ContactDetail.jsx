import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SOURCE_LABELS, fmtDate, money, sourceLink, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, StatusBadge } from '../components/ui.jsx';
import { Popover } from '../components/shell.jsx';
import { ContactForm } from './Contacts.jsx';
import { NewSaleButton, SalesTable } from './AllSales.jsx';

function NewPurchaseButton({ vendorId }) {
  return (
    <Popover
      align="right"
      trigger={({ toggle }) => (
        <button type="button" className="btn btn-primary" onClick={toggle}>
          New transaction ▾
        </button>
      )}
    >
      <div className="menu-list">
        <Link to={`/bills/new?vendor_id=${vendorId}`}>Bill</Link>
        <Link to={`/expenses/new?vendor_id=${vendorId}`}>Expense</Link>
        <Link to={`/checks/new?vendor_id=${vendorId}`}>Check</Link>
        <Link to={`/pay-bills?vendor_id=${vendorId}`}>Pay bills</Link>
      </div>
    </Popover>
  );
}

export default function ContactDetail({ kind }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = useApp();
  const isCustomer = kind === 'customers';
  const contact = useApi(`/${kind}/${id}`);
  const txns = useApi(isCustomer ? `/sales/transactions?customer_id=${id}` : `/purchases/transactions?vendor_id=${id}`);
  const [editing, setEditing] = useState(false);

  if (contact.loading && !contact.data) return <Loading />;
  if (contact.error) return <ErrorBanner error={contact.error} />;
  const c = contact.data;

  return (
    <>
      <div className="breadcrumb">
        <Link to={`/${kind}`}>{isCustomer ? 'Customers' : 'Vendors'}</Link> ›
      </div>
      <div className="card contact-head">
        <div className="contact-main">
          <div className="contact-avatar">{c.name.charAt(0).toUpperCase()}</div>
          <div>
            <h1>
              {c.name} {!c.active && <span className="badge badge-gray">inactive</span>}
            </h1>
            {c.company && <div className="muted">{c.company}</div>}
            <div className="contact-meta">
              {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
              {c.phone && <span>{c.phone}</span>}
            </div>
            {c.address && <div className="pre small muted">{c.address}</div>}
          </div>
        </div>
        <div className="contact-side">
          <div className="contact-balances">
            <div>
              <div className="kpi-label">Open balance</div>
              <div className="kpi-value small-kpi">{money(c.open_balance)}</div>
            </div>
            <div>
              <div className="kpi-label">Overdue</div>
              <div className={`kpi-value small-kpi ${c.overdue_balance > 0 ? 'neg' : ''}`}>{money(c.overdue_balance)}</div>
            </div>
          </div>
          {canEdit && (
            <div className="page-actions">
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              {isCustomer ? <NewSaleButton customerId={c.id} /> : <NewPurchaseButton vendorId={c.id} />}
            </div>
          )}
        </div>
      </div>
      {c.notes && <div className="alert alert-info">{c.notes}</div>}

      <h2 className="section-title">Transaction list</h2>
      {txns.loading && !txns.data ? (
        <Loading />
      ) : !txns.data?.length ? (
        <div className="card">
          <Empty title="No transactions yet" />
        </div>
      ) : isCustomer ? (
        <div className="card table-wrap">
          <SalesTable rows={txns.data} navigate={navigate} showCustomer={false} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>No.</th>
                <th className="hide-sm">Category</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {txns.data.map((r) => {
                const link = r.type === 'bill_payment' ? `/bills/${r.bill_id}` : sourceLink(r.type, r.id);
                return (
                  <tr key={`${r.type}-${r.id}`} className="clickable" onClick={() => navigate(link)}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{SOURCE_LABELS[r.type]}</td>
                    <td>{r.number}</td>
                    <td className="hide-sm">{r.category}</td>
                    <td className="num">{money(r.total)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ContactForm
          kind={kind}
          contact={c}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            if (saved) contact.reload();
            else navigate(`/${kind}`);
          }}
        />
      )}
    </>
  );
}
