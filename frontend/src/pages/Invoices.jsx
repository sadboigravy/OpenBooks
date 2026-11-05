import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDate, money, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, StatusBadge, Tabs } from '../components/ui.jsx';
import { MoneyBar } from '../components/shell.jsx';
import { salesSegments } from './AllSales.jsx';

export const DOC_TABS = [
  ['', 'All'],
  ['unpaid', 'Unpaid'],
  ['overdue', 'Overdue'],
  ['paid', 'Paid'],
];

export default function Invoices() {
  const { canEdit } = useApp();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const customerId = params.get('customer_id') || '';
  const { data, error, loading } = useApi(`/invoices?status=${status}&customer_id=${customerId}`);
  const summary = useApi('/sales/summary');
  const navigate = useNavigate();
  const setStatus = (s) => {
    const p = new URLSearchParams(params);
    if (s) p.set('status', s);
    else p.delete('status');
    setParams(p);
  };

  const segments = salesSegments(summary.data).filter((s) => s.key !== 'estimate');

  return (
    <>
      <PageHeader title="Invoices">
        {canEdit && (
          <>
            <Link className="btn" to="/receive-payment">
              Receive payment
            </Link>
            <Link className="btn btn-primary" to={`/invoices/new${customerId ? `?customer_id=${customerId}` : ''}`}>
              Create invoice
            </Link>
          </>
        )}
      </PageHeader>
      <MoneyBar segments={segments} active={status === 'not_due' ? 'not_due' : status} onSelect={(k) => navigate(k === 'paid' ? '/sales' : `/invoices${k ? `?status=${k}` : ''}`)} />
      <div className="toolbar">
        <Tabs tabs={[...DOC_TABS, ['draft', 'Drafts'], ['void', 'Voided']]} value={status} onChange={setStatus} />
        {customerId && data?.[0] && (
          <button className="chip" onClick={() => setParams(status ? { status } : {})}>
            Customer: {data[0].customer} ×
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title="No invoices here">{canEdit && <Link to="/invoices/new">Create an invoice</Link>}</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>No.</th>
                <th>Customer</th>
                <th className="hide-sm">Due date</th>
                <th className="num">Amount</th>
                <th className="num hide-sm">Balance</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td>{fmtDate(i.date)}</td>
                  <td>
                    <Link to={`/invoices/${i.id}`} onClick={(e) => e.stopPropagation()}>
                      {i.number}
                    </Link>
                  </td>
                  <td>{i.customer}</td>
                  <td className="hide-sm">{fmtDate(i.due_date)}</td>
                  <td className="num">{money(i.total)}</td>
                  <td className="num hide-sm">{money(i.balance)}</td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {canEdit && ['open', 'partial', 'overdue'].includes(i.status) && (
                      <Link className="btn btn-sm" to={`/receive-payment?customer_id=${i.customer_id}&invoice_id=${i.id}`}>
                        Receive payment
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
