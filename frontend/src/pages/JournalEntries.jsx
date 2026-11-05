import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SOURCE_LABELS, fmtDate, money, sourceLink, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading, PageHeader, Tabs } from '../components/ui.jsx';

export default function JournalEntries() {
  const { canEdit } = useApp();
  const [source, setSource] = useState('');
  const { data, error, loading } = useApi(`/journal-entries?source=${source}`);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(null);

  return (
    <>
      <PageHeader title="Journal Entries" subtitle="Every transaction in your general ledger">
        {canEdit && (
          <Link className="btn btn-primary" to="/journal/new">
            New journal entry
          </Link>
        )}
      </PageHeader>
      <div className="toolbar">
        <Tabs tabs={[['', 'All'], ['manual', 'Manual'], ['invoice', 'Invoices'], ['invoice_payment', 'Payments'], ['bill', 'Bills'], ['expense', 'Expenses'], ['bank', 'Bank'], ['deposit', 'Deposits'], ['transfer', 'Transfers'], ['payroll', 'Payroll']]} value={source} onChange={setSource} />
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title="No journal entries" />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Memo</th>
                <th className="hide-sm">Type</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((e) => {
                const link = sourceLink(e.source_type, e.source_id, e.id);
                const editable = e.source_type === 'manual' && canEdit;
                return [
                  <tr key={e.id} className="clickable" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <td>{fmtDate(e.date)}</td>
                    <td>
                      {e.memo || <span className="muted">(no memo)</span>}
                      {e.reference && <span className="muted small"> · #{e.reference}</span>}
                    </td>
                    <td className="hide-sm">{SOURCE_LABELS[e.source_type]}</td>
                    <td className="num">{money(e.total)}</td>
                    <td className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                      {link && (
                        <Link className={`btn btn-sm ${editable ? '' : 'btn-ghost'}`} to={link}>
                          {editable ? 'Edit' : 'Open'}
                        </Link>
                      )}
                    </td>
                  </tr>,
                  expanded === e.id && (
                    <tr key={`${e.id}-lines`} className="subrow">
                      <td colSpan={5}>
                        <table className="table compact">
                          <tbody>
                            {e.lines.map((l) => (
                              <tr key={l.id}>
                                <td>{l.account}</td>
                                <td className="muted">{l.description}</td>
                                <td className="num">{l.debit ? money(l.debit) : ''}</td>
                                <td className="num">{l.credit ? money(l.credit) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
