import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmtDate, money, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, StatusBadge, Tabs } from '../components/ui.jsx';

export default function Estimates() {
  const { canEdit } = useApp();
  const [status, setStatus] = useState('');
  const { data, error, loading } = useApi(`/invoices?kind=estimate&status=${status}`);
  const navigate = useNavigate();
  const open = (data || []).filter((e) => ['pending', 'accepted'].includes(e.status));

  return (
    <>
      <PageHeader title="Estimates" subtitle={data ? `${open.length} open · ${money(open.reduce((s, e) => s + e.total, 0))}` : null}>
        {canEdit && (
          <Link className="btn btn-primary" to="/estimates/new">
            Create estimate
          </Link>
        )}
      </PageHeader>
      <div className="toolbar">
        <Tabs
          tabs={[
            ['', 'All'],
            ['pending', 'Pending'],
            ['accepted', 'Accepted'],
            ['expired', 'Expired'],
            ['closed', 'Converted'],
            ['rejected', 'Rejected'],
          ]}
          value={status}
          onChange={setStatus}
        />
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title="No estimates">Send a customer a quote, then turn it into an invoice when they accept.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>No.</th>
                <th>Customer</th>
                <th className="hide-sm">Expires</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`/estimates/${e.id}`)}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{e.number}</td>
                  <td>{e.customer}</td>
                  <td className="hide-sm">{fmtDate(e.due_date)}</td>
                  <td className="num">{money(e.total)}</td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                    {canEdit && ['pending', 'accepted', 'expired'].includes(e.status) && (
                      <Link className="btn btn-sm" to={`/invoices/new?from_estimate=${e.id}`}>
                        Create invoice
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
