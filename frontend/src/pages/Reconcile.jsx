import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtDate, money, post, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, PageHeader } from '../components/ui.jsx';

const reconcilable = (a) => ['bank', 'cash', 'credit_card'].includes(a.subtype);

export default function Reconcile() {
  const { accounts, canEdit, notify } = useApp();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '');
  const [statementDate, setStatementDate] = useState(today());
  const [ending, setEnding] = useState('');
  const ws = useApi(accountId ? `/reconcile/${accountId}` : null);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [accountId]);

  async function undo(recId) {
    if (!window.confirm('Undo this reconciliation? Its transactions will become unreconciled.')) return;
    try {
      await post(`/reconcile/history/${recId}/undo`);
      notify('Reconciliation undone');
      ws.reload();
    } catch (err) {
      setError(err);
    }
  }

  const account = accounts.find((a) => a.id === accountId);

  return (
    <>
      <PageHeader title="Reconcile" subtitle="Match your books to your bank or credit card statement" />
      <div className="card reconcile-start">
        <h2>Which account do you want to reconcile?</h2>
        <form
          className="form-grid cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/reconcile/${accountId}?statement_date=${statementDate}&ending_balance=${ending}`);
          }}
        >
          <Field label="Account *" className="span-2">
            <AccountSelect value={accountId} onChange={setAccountId} filter={reconcilable} required />
          </Field>
          <div />
          <div />
          <Field label="Beginning balance">
            <input value={ws.data ? money(ws.data.beginning_balance) : ''} readOnly />
          </Field>
          <Field label="Ending balance *" hint="From your statement">
            <input type="number" step="0.01" value={ending} onChange={(e) => setEnding(e.target.value)} required />
          </Field>
          <Field label="Ending date *" hint={ws.data?.last_statement_date ? `Last statement ended ${fmtDate(ws.data.last_statement_date)}` : 'Never reconciled'}>
            <input type="date" value={statementDate} min={ws.data?.last_statement_date || undefined} onChange={(e) => setStatementDate(e.target.value)} required />
          </Field>
          <div className="form-end">
            <button className="btn btn-primary" disabled={!canEdit || !accountId || ending === ''}>
              Start reconciling
            </button>
          </div>
        </form>
      </div>
      <ErrorBanner error={error} />
      {account && (
        <div className="card table-wrap">
          <div className="card-header">
            <h2>History for {account.name}</h2>
          </div>
          {ws.loading && !ws.data ? (
            <Loading />
          ) : !ws.data?.history.length ? (
            <Empty title="No reconciliations yet" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Statement ending date</th>
                  <th className="hide-sm">Reconciled on</th>
                  <th className="num">Beginning balance</th>
                  <th className="num">Ending balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ws.data.history.map((r, i) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.statement_date)}</td>
                    <td className="hide-sm">{fmtDate(r.completed_at?.slice(0, 10))}</td>
                    <td className="num">{money(r.beginning_balance)}</td>
                    <td className="num">{money(r.ending_balance)}</td>
                    <td className="row-actions">
                      {canEdit && i === 0 && (
                        <button className="btn btn-sm btn-danger-ghost" onClick={() => undo(r.id)}>
                          Undo
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
