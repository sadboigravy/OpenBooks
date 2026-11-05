import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { SOURCE_LABELS, fmtDate, money, post, sourceLink, useApi, useApp } from '../lib.jsx';
import { cssVar, useUiZoom } from '../theme.js';
import { useRemoveSampleData } from '../components/DataSettings.jsx';
import { Empty, ErrorBanner, Loading, PageHeader } from '../components/ui.jsx';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

function Kpi({ label, value, sub, to, tone }) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone || ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="card kpi kpi-link">
      {body}
    </Link>
  ) : (
    <div className="card kpi">{body}</div>
  );
}

function SampleDataPrompt({ onLoaded }) {
  const { user, notify, refreshAccounts, refreshSettings, refreshItems, refreshTax } = useApp();
  const [busy, setBusy] = useState(false);
  if (user.role !== 'admin') return null;
  async function load() {
    setBusy(true);
    try {
      await post('/settings/sample-data');
      await Promise.all([refreshAccounts(), refreshSettings(), refreshItems(), refreshTax()]);
      notify('Sample data loaded');
      onLoaded();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card welcome">
      <div>
        <h2>Welcome to OpenBooks</h2>
        <p className="muted">
          Your books are empty. Start by adding customers and creating an invoice, recording an expense, or importing a
          bank statement — or load sample data to explore.
        </p>
      </div>
      <div className="welcome-actions">
        <Link className="btn btn-primary" to="/invoices/new">
          Create invoice
        </Link>
        <Link className="btn" to="/banking">
          Import bank transactions
        </Link>
        <button type="button" className="btn btn-ghost" onClick={load} disabled={busy}>
          {busy ? 'Loading…' : 'Load sample data'}
        </button>
      </div>
    </div>
  );
}

function SampleDataBanner({ onRemoved }) {
  const { user } = useApp();
  const remove = useRemoveSampleData();
  return (
    <div className="card sample-banner">
      <div>
        <strong>You're looking at sample data.</strong>
        <span className="muted"> Remove it when you're ready to enter your own.</span>
      </div>
      {user.role === 'admin' && (
        <button type="button" className="btn" onClick={async () => (await remove()) && onRemoved()}>
          Remove sample data
        </button>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { settings, theme } = useApp();
  const { data, error, loading, reload } = useApi('/dashboard');
  const navigate = useNavigate();
  const zoom = useUiZoom();

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const chartData = {
    labels: data.series.map((s) => s.month.split(' ')[0]),
    datasets: [
      { label: 'Income', data: data.series.map((s) => s.income), backgroundColor: cssVar('--chart-income'), borderRadius: 5, maxBarThickness: 20 * zoom },
      { label: 'Expenses', data: data.series.map((s) => s.expenses), backgroundColor: cssVar('--chart-expense'), borderRadius: 5, maxBarThickness: 20 * zoom },
    ],
  };
  // the chart is exempt from the ultrawide page zoom, so scale its text to match the page
  const font = { size: Math.round(12 * zoom) };
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', align: 'end', labels: { boxWidth: 10 * zoom, boxHeight: 10 * zoom, usePointStyle: true, color: cssVar('--chart-text'), font } },
      tooltip: { bodyFont: font, titleFont: font, padding: 6 * zoom, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}`, title: (items) => data.series[items[0].dataIndex].month } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: cssVar('--chart-text'), font }, border: { display: false } },
      y: { ticks: { color: cssVar('--chart-text'), font, callback: (v) => money(v).replace(/\.00$/, '') }, grid: { color: cssVar('--chart-grid') }, border: { display: false } },
    },
  };

  return (
    <>
      <PageHeader title="Dashboard" subtitle={settings.company_name}>
        <Link className="btn btn-primary" to="/invoices/new">
          + Invoice
        </Link>
        <Link className="btn" to="/expenses?new=1">
          + Expense
        </Link>
      </PageHeader>

      {settings.books_empty && <SampleDataPrompt onLoaded={reload} />}
      {settings.sample_data_loaded && <SampleDataBanner onRemoved={reload} />}

      <div className="kpi-grid">
        <Kpi label="Cash in bank" value={money(data.cash)} to="/banking" />
        <Kpi
          label="Owed to you"
          value={money(data.receivable)}
          sub={data.overdue_count ? `${money(data.overdue_total)} overdue (${data.overdue_count})` : 'Nothing overdue'}
          tone={data.overdue_count ? 'warn' : ''}
          to="/invoices?status=unpaid"
        />
        <Kpi label="You owe (bills)" value={money(data.payable)} to="/bills?status=unpaid" />
        <Kpi label="Credit cards" value={money(data.credit_card)} to="/banking" />
      </div>

      <div className="kpi-grid">
        <Kpi label="Income this month" value={money(data.month.income)} />
        <Kpi label="Expenses this month" value={money(data.month.expenses)} />
        <Kpi label="Net profit this month" value={money(data.month.net)} tone={data.month.net < 0 ? 'neg' : 'pos'} />
        <Kpi label="Net profit (fiscal YTD)" value={money(data.ytd.net)} tone={data.ytd.net < 0 ? 'neg' : 'pos'} to="/reports/profit-loss" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Income vs expenses</h2>
            <span className="muted">Last 12 months</span>
          </div>
          <div className="chart-box">
            <Bar key={`${theme}-${zoom}`} data={chartData} options={chartOptions} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Overdue invoices</h2>
            <Link to="/invoices?status=overdue">View all</Link>
          </div>
          {data.overdue_invoices.length === 0 ? (
            <Empty title="No overdue invoices">You're all caught up.</Empty>
          ) : (
            <table className="table compact">
              <tbody>
                {data.overdue_invoices.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => navigate(`/invoices/${i.id}`)}>
                    <td>
                      <div>{i.customer}</div>
                      <small className="muted">
                        {i.number} · due {fmtDate(i.due_date)}
                      </small>
                    </td>
                    <td className="num neg">{money(i.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.bank_to_review > 0 && (
            <Link to="/banking" className="callout">
              {data.bank_to_review} bank transaction{data.bank_to_review === 1 ? '' : 's'} waiting for review →
            </Link>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Upcoming bills</h2>
            <Link to="/bills?status=unpaid">View all</Link>
          </div>
          {data.bills_due.length === 0 ? (
            <Empty title="No unpaid bills" />
          ) : (
            <table className="table compact">
              <tbody>
                {data.bills_due.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => navigate(`/bills/${b.id}`)}>
                    <td>
                      <div>{b.vendor}</div>
                      <small className={b.status === 'overdue' ? 'neg' : 'muted'}>
                        {b.status === 'overdue' ? 'Overdue · ' : ''}due {fmtDate(b.due_date)}
                      </small>
                    </td>
                    <td className="num">{money(b.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Recent activity</h2>
            <Link to="/journal">Journal</Link>
          </div>
          {data.recent_entries.length === 0 ? (
            <Empty title="No transactions yet" />
          ) : (
            <table className="table compact">
              <tbody>
                {data.recent_entries.map((e) => {
                  const link = sourceLink(e.source_type, e.source_id, e.id);
                  return (
                    <tr key={e.id} className={link ? 'clickable' : ''} onClick={() => link && navigate(link)}>
                      <td>
                        <div>{e.memo || SOURCE_LABELS[e.source_type]}</div>
                        <small className="muted">
                          {fmtDate(e.date)} · {SOURCE_LABELS[e.source_type]}
                        </small>
                      </td>
                      <td className="num">{money(e.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
