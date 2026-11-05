import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SOURCE_LABELS, fmtDate, money, sourceLink, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, StatusBadge } from '../components/ui.jsx';
import { MoneyBar, Popover } from '../components/shell.jsx';

export function salesSegments(summary) {
  if (!summary) return [];
  return [
    { key: 'estimate', label: 'open estimates', tone: 'blue', ...summary.estimates },
    { key: 'overdue', label: 'overdue', tone: 'red', ...summary.overdue },
    { key: 'not_due', label: 'open invoices', tone: 'amber', ...summary.not_due },
    { key: 'paid', label: 'paid last 30 days', tone: 'green', ...summary.paid },
  ];
}

export function NewSaleButton({ customerId }) {
  const q = customerId ? `?customer_id=${customerId}` : '';
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
        <Link to={`/invoices/new${q}`}>Invoice</Link>
        <Link to={`/receive-payment${q}`}>Payment</Link>
        <Link to={`/estimates/new${q}`}>Estimate</Link>
        <Link to={`/sales-receipts/new${q}`}>Sales receipt</Link>
      </div>
    </Popover>
  );
}

export function SalesTable({ rows, navigate, showCustomer = true }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>No.</th>
          {showCustomer && <th>Customer</th>}
          <th className="hide-sm">Due date</th>
          <th className="num hide-sm">Balance</th>
          <th className="num">Total</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const link = r.type === 'payment' ? `/invoices/${r.invoice_id}` : sourceLink(r.type, r.id);
          return (
            <tr key={`${r.type}-${r.id}`} className="clickable" onClick={() => navigate(link)}>
              <td>{fmtDate(r.date)}</td>
              <td>{SOURCE_LABELS[r.type]}</td>
              <td>{r.number}</td>
              {showCustomer && <td>{r.customer}</td>}
              <td className="hide-sm">{fmtDate(r.due_date)}</td>
              <td className="num hide-sm">{r.type === 'invoice' ? money(r.balance) : ''}</td>
              <td className="num">{money(r.total)}</td>
              <td>{r.type === 'payment' ? <span className="muted small">{r.memo}</span> : <StatusBadge status={r.status} />}</td>
              <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                {r.type === 'invoice' && ['open', 'partial', 'overdue'].includes(r.status) && (
                  <Link className="btn btn-sm" to={`/receive-payment?customer_id=${r.customer_id}&invoice_id=${r.id}`}>
                    Receive payment
                  </Link>
                )}
                {r.type === 'estimate' && ['pending', 'accepted', 'expired'].includes(r.status) && (
                  <Link className="btn btn-sm" to={`/invoices/new?from_estimate=${r.id}`}>
                    Create invoice
                  </Link>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function AllSales() {
  const { canEdit } = useApp();
  const navigate = useNavigate();
  const summary = useApi('/sales/summary');
  const { data, error, loading } = useApi('/sales/transactions');
  const [filter, setFilter] = useState('');
  const [type, setType] = useState('');

  const rows = (data || []).filter((r) => {
    if (type && r.type !== type) return false;
    if (filter === 'estimate') return r.type === 'estimate' && ['pending', 'accepted', 'expired'].includes(r.status);
    if (filter === 'overdue') return r.type === 'invoice' && r.status === 'overdue';
    if (filter === 'not_due') return r.type === 'invoice' && ['open', 'partial'].includes(r.status);
    if (filter === 'paid') {
      const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      return (r.type === 'payment' || r.type === 'sales_receipt') && r.date >= cutoff;
    }
    return true;
  });

  return (
    <>
      <PageHeader title="Sales transactions">{canEdit && <NewSaleButton />}</PageHeader>
      <MoneyBar segments={salesSegments(summary.data)} active={filter} onSelect={setFilter} />
      <div className="toolbar">
        <select value={type} onChange={(e) => setType(e.target.value)} className="auto-width" aria-label="Type">
          <option value="">All transactions</option>
          <option value="invoice">Invoices</option>
          <option value="estimate">Estimates</option>
          <option value="sales_receipt">Sales receipts</option>
          <option value="payment">Payments</option>
        </select>
        {filter && (
          <button className="chip" onClick={() => setFilter('')}>
            Clear filter ×
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty title="No sales transactions">{canEdit && 'Use New transaction to create an invoice, estimate or sales receipt.'}</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <SalesTable rows={rows} navigate={navigate} />
        </div>
      )}
    </>
  );
}
