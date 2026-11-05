import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SOURCE_LABELS, fmtDate, money, post, round2, sourceLink, today, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Loading, Tabs } from '../components/ui.jsx';

export default function ReconcileWorkspace() {
  const { accountId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useApp();
  // opened directly (bookmark, refresh) without a date: use today's
  const statementDate = params.get('statement_date') || today();
  const endingBalance = params.get('ending_balance') || '0';
  const ws = useApi(`/reconcile/${accountId}?statement_date=${statementDate}`);
  const [checked, setChecked] = useState(() => new Set());
  const [tab, setTab] = useState('all');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const lines = ws.data?.lines || [];
  const isCard = ws.data?.account.subtype === 'credit_card';
  // For a bank: increases are deposits, decreases are payments. For a card: increases are charges.
  const decreaseLabel = isCard ? 'Payments' : 'Payments';
  const increaseLabel = isCard ? 'Charges' : 'Deposits';

  const totals = useMemo(() => {
    let inc = 0;
    let dec = 0;
    lines.forEach((l) => {
      if (!checked.has(l.id)) return;
      if (l.amount >= 0) inc += l.amount;
      else dec += -l.amount;
    });
    return { inc: round2(inc), dec: round2(dec) };
  }, [lines, checked]);

  if (ws.loading && !ws.data) return <Loading />;
  if (ws.error) return <ErrorBanner error={ws.error} />;

  const beginning = ws.data.beginning_balance;
  const cleared = round2(beginning + totals.inc - totals.dec);
  const ending = round2(Number(endingBalance));
  const difference = round2(ending - cleared);
  const visible = lines.filter((l) => (tab === 'inc' ? l.amount >= 0 : tab === 'dec' ? l.amount < 0 : true));
  const allVisibleChecked = visible.length > 0 && visible.every((l) => checked.has(l.id));

  const toggle = (id) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await post(`/reconcile/${accountId}`, { statement_date: statementDate, ending_balance: ending, line_ids: [...checked] });
      notify(`${ws.data.account.name} reconciled through ${fmtDate(statementDate)}`);
      navigate('/reconcile');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="breadcrumb">
        <Link to="/reconcile">Reconcile</Link> ›
      </div>
      <div className="page-header">
        <div>
          <h1>Reconcile {ws.data.account.name}</h1>
          <p className="muted">Statement ending date {fmtDate(statementDate)}</p>
        </div>
        <div className="page-actions">
          <Field label="Edit ending balance">
            <input type="number" step="0.01" value={endingBalance} onChange={(e) => setParams({ statement_date: statementDate, ending_balance: e.target.value }, { replace: true })} />
          </Field>
          <button className="btn btn-primary" disabled={difference !== 0 || busy} onClick={finish} title={difference !== 0 ? 'The difference must be 0.00' : ''}>
            {busy ? 'Finishing…' : 'Finish now'}
          </button>
        </div>
      </div>
      <ErrorBanner error={error} />

      <div className="card recon-summary">
        <div className="recon-figures">
          <div>
            <div className="recon-value">{money(ending)}</div>
            <div className="recon-label">Statement ending balance</div>
          </div>
          <div className="recon-op">−</div>
          <div>
            <div className="recon-value">{money(cleared)}</div>
            <div className="recon-label">Cleared balance</div>
          </div>
          <div className="recon-breakdown muted small">
            <div>
              {money(beginning)} <span>beginning balance</span>
            </div>
            <div>
              {money(totals.dec)} <span>{checked.size ? `${lines.filter((l) => checked.has(l.id) && l.amount < 0).length} ` : ''}
              {decreaseLabel.toLowerCase()}</span>
            </div>
            <div>
              {money(totals.inc)} <span>{checked.size ? `${lines.filter((l) => checked.has(l.id) && l.amount >= 0).length} ` : ''}
              {increaseLabel.toLowerCase()}</span>
            </div>
          </div>
        </div>
        <div className={`recon-difference ${difference === 0 ? 'done' : ''}`}>
          <div className="recon-value">{money(difference)}</div>
          <div className="recon-label">Difference</div>
          {difference === 0 && <div className="recon-ok">✓ Ready to finish</div>}
        </div>
      </div>

      <div className="toolbar">
        <Tabs
          tabs={[
            ['dec', decreaseLabel],
            ['inc', increaseLabel],
            ['all', 'All'],
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="muted small">Tick each transaction that appears on your statement.</span>
      </div>
      <div className="card table-wrap">
        {visible.length === 0 ? (
          <div className="empty">
            <strong>No unreconciled transactions</strong>
            <span className="muted">Everything up to this date has been reconciled.</span>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="hide-sm">Type</th>
                <th className="hide-sm">Ref no.</th>
                <th>Payee / memo</th>
                <th className="num">{decreaseLabel.replace(/s$/, '')}</th>
                <th className="num">{increaseLabel.replace(/s$/, '')}</th>
                <th className="center" style={{ width: 48 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    aria-label="Select all"
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        visible.forEach((l) => (e.target.checked ? next.add(l.id) : next.delete(l.id)));
                        return next;
                      })
                    }
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => {
                const link = sourceLink(l.source_type, l.source_id, l.entry_id);
                return (
                  <tr key={l.id} className={`clickable ${checked.has(l.id) ? 'row-checked' : ''}`} onClick={() => toggle(l.id)}>
                    <td>{fmtDate(l.date)}</td>
                    <td className="hide-sm">{SOURCE_LABELS[l.source_type]}</td>
                    <td className="hide-sm">{l.reference}</td>
                    <td>
                      {link ? (
                        <Link to={link} onClick={(e) => e.stopPropagation()}>
                          {l.memo}
                        </Link>
                      ) : (
                        l.memo
                      )}
                    </td>
                    <td className="num">{l.amount < 0 ? money(-l.amount) : ''}</td>
                    <td className="num">{l.amount >= 0 ? money(l.amount) : ''}</td>
                    <td className="center">
                      <input type="checkbox" checked={checked.has(l.id)} onChange={() => toggle(l.id)} onClick={(e) => e.stopPropagation()} aria-label="Cleared" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
