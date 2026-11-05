import { Fragment, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { SOURCE_LABELS, downloadCsv, fmtDate, money, sourceLink, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, PageHeader } from '../components/ui.jsx';
import { REPORTS } from './Reports.jsx';

const PERIOD_TYPES = ['profit-loss', 'general-ledger'];

function presetRange(preset, fyStartMonth) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const y = now.getFullYear();
  const m = now.getMonth();
  const fyStart = new Date(m + 1 >= fyStartMonth ? y : y - 1, fyStartMonth - 1, 1);
  switch (preset) {
    case 'this-month':
      return [iso(new Date(y, m, 1)), iso(now)];
    case 'last-month':
      return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case 'this-quarter': {
      const q = Math.floor(m / 3) * 3;
      return [iso(new Date(y, q, 1)), iso(now)];
    }
    case 'last-year':
      return [iso(new Date(fyStart.getFullYear() - 1, fyStart.getMonth(), 1)), iso(new Date(fyStart.getFullYear(), fyStart.getMonth(), 0))];
    default:
      return [iso(fyStart), iso(now)];
  }
}

const AGING_COLS = [
  ['current', 'Current'],
  ['1_30', '1–30'],
  ['31_60', '31–60'],
  ['61_90', '61–90'],
  ['over_90', '90+'],
  ['total', 'Total'],
];

function toCsv(type, r) {
  const rows = [];
  const sections = () =>
    r.sections.forEach((s) => {
      rows.push([s.title, '']);
      s.rows.forEach((x) => rows.push([`${x.code ? `${x.code} ` : ''}${x.name}`, x.amount]));
      rows.push([`Total ${s.title}`, s.total]);
    });
  if (type === 'profit-loss') {
    rows.push(['Account', 'Amount']);
    sections();
    rows.push(['Gross profit', r.gross_profit], ['Net income', r.net_income]);
  } else if (type === 'balance-sheet') {
    rows.push(['Account', 'Amount']);
    sections();
    rows.push(['Total liabilities and equity', r.total_liabilities_and_equity]);
  } else if (type === 'trial-balance') {
    rows.push(['Account', 'Debit', 'Credit']);
    r.rows.forEach((x) => rows.push([`${x.code} ${x.name}`, x.debit || '', x.credit || '']));
    rows.push(['Total', r.total_debit, r.total_credit]);
  } else if (type === 'ar-aging' || type === 'ap-aging') {
    rows.push([type === 'ar-aging' ? 'Customer' : 'Vendor', ...AGING_COLS.map((c) => c[1])]);
    r.rows.forEach((x) => rows.push([x.name, ...AGING_COLS.map(([k]) => x[k])]));
    rows.push(['Total', ...AGING_COLS.map(([k]) => r.totals[k])]);
  } else if (type === 'general-ledger') {
    rows.push(['Account', 'Date', 'Type', 'Memo', 'Debit', 'Credit', 'Balance']);
    r.accounts.forEach((a) => {
      rows.push([`${a.code} ${a.name}`, '', '', 'Opening balance', '', '', a.opening]);
      a.rows.forEach((x) => rows.push([`${a.code} ${a.name}`, x.date, SOURCE_LABELS[x.source_type], x.memo, x.debit || '', x.credit || '', x.balance]));
    });
  }
  return rows;
}

function Sections({ report }) {
  return report.sections.map((s) => {
    if (!s.rows.length && s.title === 'Cost of Goods Sold') return null;
    return (
      <Fragment key={s.title}>
        <tr className="section-row">
          <td colSpan={2}>{s.title}</td>
        </tr>
        {s.rows.length === 0 && (
          <tr>
            <td className="indent muted" colSpan={2}>
              None
            </td>
          </tr>
        )}
        {s.rows.map((r, i) => (
          <tr key={i}>
            <td className="indent">
              {r.account_id ? <Link to={`/reports/general-ledger?account_id=${r.account_id}&start=${report.start || ''}&end=${report.end || report.as_of}`}>{r.name}</Link> : r.name}
            </td>
            <td className="num">{money(r.amount)}</td>
          </tr>
        ))}
        <tr className="total-row">
          <td>Total {s.title}</td>
          <td className="num">{money(s.total)}</td>
        </tr>
      </Fragment>
    );
  });
}

function ProfitLoss({ r }) {
  return (
    <table className="table report-table">
      <tbody>
        <Sections report={r} />
        <tr className="total-row">
          <td>Gross profit</td>
          <td className="num">{money(r.gross_profit)}</td>
        </tr>
        <tr className="grand-row">
          <td>Net income</td>
          <td className={`num ${r.net_income < 0 ? 'neg' : ''}`}>{money(r.net_income)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function BalanceSheet({ r }) {
  return (
    <>
      {!r.balanced && <div className="alert alert-warn">Assets do not equal liabilities plus equity. Check for unusual manual journal entries.</div>}
      <table className="table report-table">
        <tbody>
          <Sections report={r} />
          <tr className="grand-row">
            <td>Total liabilities and equity</td>
            <td className="num">{money(r.total_liabilities_and_equity)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function TrialBalance({ r }) {
  return (
    <table className="table report-table">
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {r.rows.map((x) => (
          <tr key={x.account_id}>
            <td>
              <Link to={`/reports/general-ledger?account_id=${x.account_id}`}>
                {x.code} · {x.name}
              </Link>
            </td>
            <td className="num">{x.debit ? money(x.debit) : ''}</td>
            <td className="num">{x.credit ? money(x.credit) : ''}</td>
          </tr>
        ))}
        <tr className="grand-row">
          <td>Total</td>
          <td className="num">{money(r.total_debit)}</td>
          <td className="num">{money(r.total_credit)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Aging({ r, kind }) {
  const cols = AGING_COLS;
  const [open, setOpen] = useState(null);
  if (!r.rows.length) return <Empty title={kind === 'ar' ? 'No unpaid invoices' : 'No unpaid bills'} />;
  return (
    <table className="table report-table">
      <thead>
        <tr>
          <th>{kind === 'ar' ? 'Customer' : 'Vendor'}</th>
          {cols.map(([k, l]) => (
            <th key={k} className="num">
              {l}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {r.rows.map((x) => (
          <Fragment key={x.contact_id}>
            <tr className="clickable" onClick={() => setOpen(open === x.contact_id ? null : x.contact_id)}>
              <td>
                {open === x.contact_id ? '▾' : '▸'} {x.name}
              </td>
              {cols.map(([k]) => (
                <td key={k} className={`num ${k === 'total' ? 'strong' : ''}`}>
                  {x[k] ? money(x[k]) : ''}
                </td>
              ))}
            </tr>
            {open === x.contact_id &&
              x.docs.map((d) => (
                <tr key={d.id} className="subrow">
                  <td className="indent" colSpan={7}>
                    <Link to={`/${kind === 'ar' ? 'invoices' : 'bills'}/${d.id}`}>{d.number || 'Bill'}</Link> · due {fmtDate(d.due_date)}
                    {d.days_overdue > 0 && <span className="neg"> · {d.days_overdue} days overdue</span>} · {money(d.balance)}
                  </td>
                </tr>
              ))}
          </Fragment>
        ))}
        <tr className="grand-row">
          <td>Total</td>
          {cols.map(([k]) => (
            <td key={k} className="num">
              {money(r.totals[k])}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function GeneralLedger({ r }) {
  if (!r.accounts.length) return <Empty title="No activity in this period" />;
  return r.accounts.map((a) => {
    return (
      <div key={a.account_id} className="gl-account">
        <h3>
          {a.code} · {a.name}
        </h3>
        <table className="table report-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="hide-sm">Type</th>
              <th>Memo</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="muted">
              <td colSpan={5}>Opening balance</td>
              <td className="num">{money(a.opening)}</td>
            </tr>
            {a.rows.map((x, i) => {
              const link = sourceLink(x.source_type, x.source_id, x.entry_id);
              return (
                <tr key={i}>
                  <td>{fmtDate(x.date)}</td>
                  <td className="hide-sm">{SOURCE_LABELS[x.source_type]}</td>
                  <td>{link ? <Link to={link}>{x.memo}</Link> : x.memo}</td>
                  <td className="num">{x.debit ? money(x.debit) : ''}</td>
                  <td className="num">{x.credit ? money(x.credit) : ''}</td>
                  <td className="num">{money(x.balance)}</td>
                </tr>
              );
            })}
            <tr className="total-row">
              <td colSpan={5}>Closing balance</td>
              <td className="num">{money(a.closing)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  });
}

export default function Report() {
  const { type } = useParams();
  const { settings } = useApp();
  const [params, setParams] = useSearchParams();
  const meta = REPORTS.find((r) => r[0] === type);
  const periodic = PERIOD_TYPES.includes(type);
  const [defStart, defEnd] = presetRange('fy', Number(settings.fiscal_year_start_month || 1));
  const start = params.get('start') || defStart;
  const end = params.get('end') || defEnd;
  const asOf = params.get('as_of') || today();
  const accountId = params.get('account_id') || '';

  const query = periodic ? `start=${start}&end=${end}${accountId ? `&account_id=${accountId}` : ''}` : `as_of=${asOf}`;
  const { data, error, loading } = useApi(meta ? `/reports/${type}?${query}` : null);

  if (!meta) return <Navigate to="/reports" />;

  const update = (changes) => {
    const p = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    setParams(p, { replace: true });
  };

  let body = null;
  if (data) {
    if (type === 'profit-loss') body = <ProfitLoss r={data} />;
    if (type === 'balance-sheet') body = <BalanceSheet r={data} />;
    if (type === 'trial-balance') body = <TrialBalance r={data} />;
    if (type === 'ar-aging') body = <Aging r={data} kind="ar" />;
    if (type === 'ap-aging') body = <Aging r={data} kind="ap" />;
    if (type === 'general-ledger') body = <GeneralLedger r={data} />;
  }

  return (
    <>
      <PageHeader title={meta[1]}>
        <Link className="btn btn-ghost" to="/reports">
          ← Reports
        </Link>
        <button className="btn" onClick={() => window.print()}>
          Print / PDF
        </button>
        <button className="btn" disabled={!data} onClick={() => downloadCsv(`${type}-${periodic ? end : asOf}.csv`, toCsv(type, data))}>
          Export CSV
        </button>
      </PageHeader>
      <div className="card report-controls no-print">
        {periodic ? (
          <>
            <Field label="Period">
              <select
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const [s, en] = presetRange(e.target.value, Number(settings.fiscal_year_start_month || 1));
                  update({ start: s, end: en });
                }}
              >
                <option value="">Custom</option>
                <option value="this-month">This month</option>
                <option value="last-month">Last month</option>
                <option value="this-quarter">This quarter</option>
                <option value="fy">This fiscal year</option>
                <option value="last-year">Last fiscal year</option>
              </select>
            </Field>
            <Field label="From">
              <input type="date" value={start} onChange={(e) => update({ start: e.target.value })} />
            </Field>
            <Field label="To">
              <input type="date" value={end} onChange={(e) => update({ end: e.target.value })} />
            </Field>
            {type === 'general-ledger' && (
              <Field label="Account" className="grow">
                <AccountSelect value={accountId ? Number(accountId) : ''} onChange={(v) => update({ account_id: v })} placeholder="All accounts" />
              </Field>
            )}
          </>
        ) : (
          <Field label="As of">
            <input type="date" value={asOf} onChange={(e) => update({ as_of: e.target.value })} />
          </Field>
        )}
      </div>
      <ErrorBanner error={error} />
      <div className="card report-paper">
        <div className="report-title">
          <div className="muted">{settings.company_name}</div>
          <h2>{meta[1]}</h2>
          <div className="muted">{periodic ? `${fmtDate(start)} – ${fmtDate(end)}` : `As of ${fmtDate(asOf)}`}</div>
        </div>
        {loading && !data ? <Loading /> : body}
      </div>
    </>
  );
}
