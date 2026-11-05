import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SOURCE_LABELS, fmtDate, money, sourceLink, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, StatusBadge } from '../components/ui.jsx';
import { MoneyBar, Popover } from '../components/shell.jsx';

export function purchaseSegments(summary) {
  if (!summary) return [];
  return [
    { key: 'overdue', label: 'overdue bills', tone: 'red', ...summary.overdue },
    { key: 'not_due', label: 'open bills', tone: 'amber', ...summary.not_due },
    { key: 'paid', label: 'paid last 30 days', tone: 'green', ...summary.paid },
  ];
}

export default function ExpensesList() {
  const { canEdit } = useApp();
  const navigate = useNavigate();
  const { data, error, loading } = useApi('/purchases/transactions');
  const summary = useApi('/purchases/summary');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');

  const rows = (data || []).filter(
    (r) => (!type || r.type === type) && (!search || `${r.payee} ${r.category} ${r.memo} ${r.number}`.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      <PageHeader title="Expense transactions">
        {canEdit && (
          <>
            <Link className="btn" to="/pay-bills">
              Pay bills
            </Link>
            <Popover
              align="right"
              trigger={({ toggle }) => (
                <button type="button" className="btn btn-primary" onClick={toggle}>
                  New transaction ▾
                </button>
              )}
            >
              <div className="menu-list">
                <Link to="/expenses/new">Expense</Link>
                <Link to="/checks/new">Check</Link>
                <Link to="/bills/new">Bill</Link>
                <Link to="/pay-bills">Pay bills</Link>
              </div>
            </Popover>
          </>
        )}
      </PageHeader>
      <MoneyBar segments={purchaseSegments(summary.data)} onSelect={(k) => navigate(k === 'paid' ? '/bills?status=paid' : `/bills?status=${k === 'overdue' ? 'overdue' : 'unpaid'}`)} />
      <div className="toolbar">
        <select value={type} onChange={(e) => setType(e.target.value)} className="auto-width" aria-label="Type">
          <option value="">All transactions</option>
          <option value="expense">Expenses</option>
          <option value="check">Checks</option>
          <option value="bill">Bills</option>
          <option value="bill_payment">Bill payments</option>
        </select>
        <input className="search" placeholder="Search payee, category, memo…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty title="No expense transactions">Record purchases, checks and bills from New transaction.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="hide-sm">No.</th>
                <th>Payee</th>
                <th className="hide-sm">Category</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const link = r.type === 'bill_payment' ? `/bills/${r.bill_id}` : sourceLink(r.type, r.id);
                return (
                  <tr key={`${r.type}-${r.id}`} className="clickable" onClick={() => navigate(link)}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{SOURCE_LABELS[r.type]}</td>
                    <td className="hide-sm">{r.number}</td>
                    <td>
                      {r.payee}
                      {r.memo && <div className="small muted">{r.memo}</div>}
                    </td>
                    <td className="hide-sm">{r.category}</td>
                    <td className="num">{money(r.total)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {canEdit && r.type === 'bill' && ['open', 'partial', 'overdue'].includes(r.status) && (
                        <Link className="btn btn-sm" to={`/pay-bills?bill_id=${r.id}`}>
                          Make payment
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
