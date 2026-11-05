import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDate, money, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, StatusBadge, Tabs } from '../components/ui.jsx';
import { DOC_TABS } from './Invoices.jsx';
import { MoneyBar } from '../components/shell.jsx';
import { purchaseSegments } from './ExpensesList.jsx';

export default function Bills() {
  const { canEdit } = useApp();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const vendorId = params.get('vendor_id') || '';
  const { data, error, loading } = useApi(`/bills?status=${status}&vendor_id=${vendorId}`);
  const navigate = useNavigate();
  const summary = useApi('/purchases/summary');
  const unpaid = (data || []).reduce((s, b) => s + b.balance, 0);

  return (
    <>
      <PageHeader title="Bills" subtitle={data ? `${data.length} shown · ${money(unpaid)} to pay` : null}>
        {canEdit && (
          <>
            <Link className="btn" to="/pay-bills">
              Pay bills
            </Link>
            <Link className="btn btn-primary" to={`/bills/new${vendorId ? `?vendor_id=${vendorId}` : ''}`}>
              Create bill
            </Link>
          </>
        )}
      </PageHeader>
      <MoneyBar
        segments={purchaseSegments(summary.data)}
        active={status === 'unpaid' ? 'not_due' : status}
        onSelect={(k) => setParams(k ? { status: k === 'not_due' ? 'unpaid' : k } : {})}
      />
      <div className="toolbar">
        <Tabs
          tabs={DOC_TABS}
          value={status}
          onChange={(s) => {
            const p = new URLSearchParams(params);
            if (s) p.set('status', s);
            else p.delete('status');
            setParams(p);
          }}
        />
        {vendorId && data?.[0] && (
          <button className="chip" onClick={() => setParams(status ? { status } : {})}>
            Vendor: {data[0].vendor} ×
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title="No bills here">
            Bills are for things you'll pay later. For purchases you've already paid, use <Link to="/expenses/new">an expense</Link>.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th className="hide-sm">Bill #</th>
                <th className="hide-sm">Date</th>
                <th>Due</th>
                <th className="num hide-sm">Total</th>
                <th className="num">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => navigate(`/bills/${b.id}`)}>
                  <td>
                    <Link to={`/bills/${b.id}`} onClick={(e) => e.stopPropagation()}>
                      {b.vendor}
                    </Link>
                  </td>
                  <td className="hide-sm">{b.number}</td>
                  <td className="hide-sm">{fmtDate(b.date)}</td>
                  <td>{fmtDate(b.due_date)}</td>
                  <td className="num hide-sm">{money(b.total)}</td>
                  <td className="num">{money(b.balance)}</td>
                  <td>
                    <StatusBadge status={b.status} />
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
