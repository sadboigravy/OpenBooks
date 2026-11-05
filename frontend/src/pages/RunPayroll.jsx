import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDays, api, money, post, startOfWeek, today, useApp } from '../lib.jsx';
import { AccountSelect, Empty, Field, Loading, isBankAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

export default function RunPayroll() {
  const navigate = useNavigate();
  const { accounts, notify } = useApp();
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const lastMonday = addDays(startOfWeek(today()), -14);
  const [period, setPeriod] = useState({ period_start: lastMonday, period_end: addDays(lastMonday, 13), pay_date: today(), account_id: defaultBank });
  const [employees, setEmployees] = useState(null);
  const [rows, setRows] = useState({});
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  // Load employees with their tracked (unpaid) hours for the period
  useEffect(() => {
    if (!period.period_start || !period.period_end || period.period_end < period.period_start) return;
    api(`/payroll/prefill?period_start=${period.period_start}&period_end=${period.period_end}`).then((list) => {
      setEmployees(list);
      setRows((prev) => {
        const next = {};
        list.forEach((e) => {
          next[e.id] = { include: prev[e.id]?.include ?? true, hours: e.pay_type === 'hourly' ? String(e.tracked_hours || '') : '' };
        });
        return next;
      });
    });
  }, [period.period_start, period.period_end]);

  const included = (employees || []).filter((e) => rows[e.id]?.include);
  const payload = {
    ...period,
    employees: included.map((e) => ({ employee_id: e.id, hours: rows[e.id].hours })),
  };
  const payloadKey = JSON.stringify(payload);

  // Live preview of every paycheck
  // Don't show an error before anyone has hours to pay
  const hasPay = included.some((e) => e.pay_type !== 'hourly' || Number(rows[e.id]?.hours) > 0);
  useEffect(() => {
    if (!included.length || !hasPay) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    const t = setTimeout(() => {
      post('/payroll/preview', payload)
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err) => {
          setPreview(null);
          setPreviewError(err);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [payloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const byEmp = Object.fromEntries((preview?.paychecks || []).map((p) => [p.employee_id, p]));

  async function submit() {
    if (!window.confirm(`Submit payroll? ${money(preview.totals.net)} in net pay will be recorded as paid from the selected account.`)) return;
    setBusy(true);
    setError(null);
    try {
      const run = await post('/payroll/runs', { ...payload, acknowledge_unverified: ack });
      notify('Payroll submitted');
      navigate(`/payroll/runs/${run.id}`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <TxnScreen
      title="Run payroll"
      fallback="/payroll"
      headline={preview ? { label: 'Total payroll cost', amount: preview.totals.total_cost } : null}
      onSave={submit}
      saveNew={false}
      saveLabel="Submit payroll"
      busy={busy}
      error={error || previewError}
      disabled={!preview || (preview.unverified_tables?.length > 0 && !ack)}
    >
      <div className="form-grid cols-4">
        <Field label="Pay period start *">
          <input type="date" value={period.period_start} onChange={(e) => setPeriod({ ...period, period_start: e.target.value })} required />
        </Field>
        <Field label="Pay period end *">
          <input type="date" value={period.period_end} min={period.period_start} onChange={(e) => setPeriod({ ...period, period_end: e.target.value })} required />
        </Field>
        <Field label="Pay date *">
          <input type="date" value={period.pay_date} onChange={(e) => setPeriod({ ...period, pay_date: e.target.value })} required />
        </Field>
        <Field label="Bank account *">
          <AccountSelect value={period.account_id} onChange={(v) => setPeriod({ ...period, account_id: v })} filter={isBankAccount} required />
        </Field>
      </div>

      {preview?.unverified_tables?.length > 0 && (
        <div className="alert alert-warn">
          <div>
            These tax tables haven't been verified by an administrator: {preview.unverified_tables.map((t) => t.name).join(', ')}. Paychecks may be wrong if the figures
            are out of date. <a href="/taxes/payroll">Review the tables</a>.
          </div>
          <label className="checkbox" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand and want to run payroll with these tables
          </label>
        </div>
      )}
      <h2 className="section-title">Employees</h2>
      {employees?.length > 0 && included.length > 0 && !hasPay && <p className="muted small">Enter hours for hourly employees to see their paychecks.</p>}
      {!employees ? (
        <Loading />
      ) : employees.length === 0 ? (
        <Empty title="No active employees">
          <Link to="/employees?new=1">Add an employee</Link> first.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <th>Employee</th>
                <th className="num" style={{ width: 110 }}>
                  Hours
                </th>
                <th className="num">Gross pay</th>
                <th className="num hide-sm">Employee taxes</th>
                <th className="num hide-sm">Deductions</th>
                <th className="num">Net pay</th>
                <th className="num hide-sm">Employer taxes</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const p = byEmp[e.id];
                const row = rows[e.id] || {};
                return (
                  <tr key={e.id} className={row.include ? '' : 'inactive'}>
                    <td>
                      <input type="checkbox" checked={!!row.include} onChange={(ev) => setRows({ ...rows, [e.id]: { ...row, include: ev.target.checked } })} aria-label={`Include ${e.name}`} />
                    </td>
                    <td>
                      <strong>{e.name}</strong>
                      <div className="small muted">
                        {e.pay_type === 'hourly' ? `${money(e.pay_rate)}/hr` : `Salary ${money(e.pay_rate)}/yr`}
                        {e.tracked_hours > 0 && ` · ${e.tracked_hours}h on timesheets`}
                      </div>
                    </td>
                    <td>
                      {e.pay_type === 'hourly' ? (
                        <input className="num" type="number" step="0.25" min="0" value={row.hours ?? ''} disabled={!row.include} onChange={(ev) => setRows({ ...rows, [e.id]: { ...row, hours: ev.target.value } })} />
                      ) : (
                        <span className="muted small">Salary</span>
                      )}
                    </td>
                    <td className="num">{p ? money(p.gross) : '—'}</td>
                    <td className="num hide-sm">{p ? money(p.employee_taxes) : '—'}</td>
                    <td className="num hide-sm">{p ? money(p.other_deduction) : '—'}</td>
                    <td className="num strong">{p ? money(p.net) : '—'}</td>
                    <td className="num hide-sm">{p ? money(p.employer_taxes) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            {preview && (
              <tfoot>
                <tr className="strong">
                  <td />
                  <td>Totals</td>
                  <td />
                  <td className="num">{money(preview.totals.gross)}</td>
                  <td className="num hide-sm">{money(preview.totals.employee_taxes)}</td>
                  <td className="num hide-sm" />
                  <td className="num">{money(preview.totals.net)}</td>
                  <td className="num hide-sm">{money(preview.totals.employer_taxes)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {preview && (
        <div className="payroll-summary">
          <div>
            <span>Net pay to employees</span>
            <strong>{money(preview.totals.net)}</strong>
          </div>
          <div>
            <span>Taxes & withholdings to remit</span>
            <strong>{money(preview.totals.gross - preview.totals.net + preview.totals.employer_taxes)}</strong>
          </div>
          <div>
            <span>Total payroll cost</span>
            <strong>{money(preview.totals.total_cost)}</strong>
          </div>
        </div>
      )}
    </TxnScreen>
  );
}
