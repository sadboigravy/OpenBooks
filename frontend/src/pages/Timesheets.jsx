import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays, api, put, round2, startOfWeek, today, useApi, useApp } from '../lib.jsx';
import { ContactSelect, Empty, ErrorBanner, Loading, PageHeader } from '../components/ui.jsx';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const blankRow = () => ({ customer_id: '', item_id: '', billable: false, description: '', hours: ['', '', '', '', '', '', ''] });

/** Group a week's editable entries into timesheet rows. */
function toRows(entries, weekStart) {
  const rows = {};
  entries.forEach((t) => {
    const key = [t.customer_id || '', t.item_id || '', t.billable, t.description].join('|');
    rows[key] = rows[key] || { customer_id: t.customer_id || '', item_id: t.item_id || '', billable: t.billable, description: t.description, hours: ['', '', '', '', '', '', ''] };
    const dayIdx = DAY_NAMES.findIndex((_, i) => addDays(weekStart, i) === t.date);
    if (dayIdx >= 0) rows[key].hours[dayIdx] = round2(Number(rows[key].hours[dayIdx] || 0) + t.hours);
  });
  const list = Object.values(rows);
  return list.length ? list : [blankRow()];
}

export default function Timesheets() {
  const { canEdit, items, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const employees = useApi('/employees');
  const customers = useApi('/customers');
  const [weekStart, setWeekStart] = useState(startOfWeek(today()));
  const employeeId = Number(params.get('employee_id')) || employees.data?.[0]?.id || '';
  const weekEnd = addDays(weekStart, 6);
  const [rows, setRows] = useState(null);
  const [locked, setLocked] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!employeeId) return;
    setRows(null);
    setError(null);
    api(`/time?employee_id=${employeeId}&start=${weekStart}&end=${weekEnd}`).then((entries) => {
      setLocked(entries.filter((t) => t.locked));
      setRows(toRows(entries.filter((t) => !t.locked), weekStart));
      setDirty(false);
    });
  }, [employeeId, weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => DAY_NAMES.map((n, i) => ({ name: n, date: addDays(weekStart, i) })), [weekStart]);

  if (employees.loading && !employees.data) return <Loading />;
  if (!employees.data?.length) {
    return (
      <>
        <PageHeader title="Weekly timesheet" />
        <div className="card">
          <Empty title="Add an employee first">
            <Link to="/employees?new=1">Add an employee</Link> to start tracking time.
          </Empty>
        </div>
      </>
    );
  }

  const setRow = (i, changes) => {
    setDirty(true);
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...changes } : r)));
  };
  const setHour = (i, d, v) => setRow(i, { hours: rows[i].hours.map((h, idx) => (idx === d ? v : h)) });
  const rowTotal = (r) => round2(r.hours.reduce((s, h) => s + Number(h || 0), 0));
  const dayTotal = (d) => round2((rows || []).reduce((s, r) => s + Number(r.hours[d] || 0), 0) + locked.filter((t) => t.date === days[d].date).reduce((s, t) => s + t.hours, 0));
  const weekTotal = round2(days.reduce((s, _, d) => s + dayTotal(d), 0));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = rows.filter((r) => rowTotal(r) > 0);
      const entries = await put('/time/week', { employee_id: employeeId, week_start: weekStart, rows: payload });
      setLocked(entries.filter((t) => t.locked));
      setRows(toRows(entries.filter((t) => !t.locked), weekStart));
      setDirty(false);
      notify('Timesheet saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const changeWeek = (delta) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setWeekStart(addDays(weekStart, delta));
  };

  return (
    <>
      <PageHeader title="Weekly timesheet" subtitle="Billable time can be added to the customer's next invoice; all hours feed into payroll.">
        <Link className="btn" to="/payroll/run">
          Run payroll
        </Link>
      </PageHeader>
      <div className="card timesheet-controls">
        <label className="field">
          <span className="field-label">Employee</span>
          <select
            value={employeeId}
            onChange={(e) => {
              if (dirty && !window.confirm('Discard unsaved changes?')) return;
              setParams({ employee_id: e.target.value });
            }}
          >
            {employees.data.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <div className="week-nav">
          <button type="button" className="btn btn-sm" onClick={() => changeWeek(-7)} aria-label="Previous week">
            ‹
          </button>
          <input type="date" value={weekStart} onChange={(e) => e.target.value && setWeekStart(startOfWeek(e.target.value))} aria-label="Week" />
          <span className="muted">to {weekEnd}</span>
          <button type="button" className="btn btn-sm" onClick={() => changeWeek(7)} aria-label="Next week">
            ›
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWeekStart(startOfWeek(today()))}>
            This week
          </button>
        </div>
        <div className="week-total">
          <div className="kpi-label">Total hours</div>
          <div className="kpi-value small-kpi">{weekTotal}</div>
        </div>
      </div>
      <ErrorBanner error={error} />
      {!rows || !customers.data ? (
        <Loading />
      ) : (
        <div className="card table-wrap">
          <table className="table timesheet">
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>Customer</th>
                <th style={{ minWidth: 150 }}>Service</th>
                <th className="center">Billable</th>
                <th style={{ minWidth: 140 }}>Description</th>
                {days.map((d) => (
                  <th key={d.date} className="num day-col">
                    {d.name}
                    <div className="muted small">{d.date.slice(8)}</div>
                  </th>
                ))}
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <ContactSelect contacts={customers.data} value={r.customer_id} onChange={(v) => setRow(i, { customer_id: v, billable: v ? r.billable : false })} placeholder="— None —" />
                  </td>
                  <td>
                    <select value={r.item_id} onChange={(e) => setRow(i, { item_id: e.target.value ? Number(e.target.value) : '' })} aria-label="Service">
                      <option value="">— None —</option>
                      {items
                        .filter((it) => it.active)
                        .map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className="center">
                    <input type="checkbox" checked={r.billable} disabled={!r.customer_id} onChange={(e) => setRow(i, { billable: e.target.checked })} aria-label="Billable" />
                  </td>
                  <td>
                    <input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                  </td>
                  {days.map((d, di) => (
                    <td key={d.date} className="day-col">
                      <input className="num hours" type="number" step="0.25" min="0" max="24" value={r.hours[di]} onChange={(e) => setHour(i, di, e.target.value)} aria-label={`${d.name} hours`} />
                    </td>
                  ))}
                  <td className="num strong">{rowTotal(r)}</td>
                  <td>
                    <button type="button" className="icon-btn" aria-label="Remove row" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [blankRow()])) || setDirty(true)}>
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
              {locked.map((t) => (
                <tr key={`locked-${t.id}`} className="locked-row">
                  <td>{t.customer || '—'}</td>
                  <td>{t.item || '—'}</td>
                  <td className="center">{t.billable ? '✓' : ''}</td>
                  <td>
                    {t.description}{' '}
                    <span className="badge badge-gray">{t.invoice_id ? 'Invoiced' : 'Paid'}</span>
                  </td>
                  {days.map((d) => (
                    <td key={d.date} className="num day-col">
                      {d.date === t.date ? t.hours : ''}
                    </td>
                  ))}
                  <td className="num">{t.hours}</td>
                  <td />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
                    Add lines
                  </button>
                </td>
                {days.map((d, di) => (
                  <td key={d.date} className="num strong day-col">
                    {dayTotal(di) || ''}
                  </td>
                ))}
                <td className="num strong">{weekTotal}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {canEdit && rows && (
        <div className="sticky-actions">
          {dirty && <span className="muted">Unsaved changes</span>}
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save timesheet'}
          </button>
        </div>
      )}
    </>
  );
}
