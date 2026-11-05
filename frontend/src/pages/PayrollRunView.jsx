import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, fmtDate, money, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Loading, PageHeader } from '../components/ui.jsx';

export default function PayrollRunView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { settings, canEdit, notify } = useApp();
  const { data: run, error, loading } = useApi(`/payroll/runs/${id}`);
  if (loading && !run) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  async function remove() {
    if (!window.confirm('Delete this payroll? The paychecks and their ledger entries will be removed, and the timesheet hours become unpaid again.')) return;
    try {
      await del(`/payroll/runs/${run.id}`);
      notify('Payroll deleted');
      navigate('/payroll');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  return (
    <>
      <PageHeader title={`Payroll · ${fmtDate(run.pay_date)}`} subtitle={`Pay period ${fmtDate(run.period_start)} – ${fmtDate(run.period_end)} · paid from ${run.account}`}>
        <Link className="btn btn-ghost" to="/payroll">
          ← Payroll
        </Link>
        <button className="btn" onClick={() => window.print()}>
          Print pay stubs
        </button>
      </PageHeader>
      <div className="kpi-grid no-print">
        <div className="card kpi">
          <div className="kpi-label">Gross pay</div>
          <div className="kpi-value">{money(run.gross)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Net pay</div>
          <div className="kpi-value">{money(run.net)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Employer taxes</div>
          <div className="kpi-value">{money(run.employer_taxes)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Total cost</div>
          <div className="kpi-value">{money(run.total_cost)}</div>
        </div>
      </div>
      {run.paychecks.map((p) => (
        <div key={p.id} className="card pay-stub">
          <div className="stub-head">
            <div>
              <div className="muted small">{settings.company_name}</div>
              <h2>{p.employee}</h2>
              <div className="muted small">
                Pay date {fmtDate(run.pay_date)} · Period {fmtDate(run.period_start)} – {fmtDate(run.period_end)}
              </div>
            </div>
            <div className="stub-net">
              <div className="muted small">Net pay</div>
              <div className="kpi-value">{money(p.net)}</div>
            </div>
          </div>
          {(p.futa > 0 || p.suta > 0 || p.method === 'tables') && (
            <div className="muted small stub-employer">
              Employer taxes (not deducted from pay): social security {money(p.employer_social_security)} · Medicare {money(p.employer_medicare)}
              {p.futa > 0 && ` · FUTA ${money(p.futa)}`}
              {p.suta > 0 && ` · SUTA ${money(p.suta)}`}
            </div>
          )}
          <div className="stub-grid">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Earnings</th>
                  <th className="num">Hours</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Gross pay</td>
                  <td className="num">{p.hours || ''}</td>
                  <td className="num">{money(p.gross)}</td>
                </tr>
              </tbody>
            </table>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Taxes & deductions</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Social security</td>
                  <td className="num">{money(p.social_security)}</td>
                </tr>
                <tr>
                  <td>Medicare</td>
                  <td className="num">{money(p.medicare)}</td>
                </tr>
                <tr>
                  <td>Federal income tax</td>
                  <td className="num">{money(p.federal_withholding)}</td>
                </tr>
                <tr>
                  <td>State income tax</td>
                  <td className="num">{money(p.state_withholding)}</td>
                </tr>
                {p.additional_medicare > 0 && (
                  <tr>
                    <td>Additional Medicare</td>
                    <td className="num">{money(p.additional_medicare)}</td>
                  </tr>
                )}
                {p.other_deduction > 0 && (
                  <tr>
                    <td>{p.other_deduction_label || 'Other deduction'}</td>
                    <td className="num">{money(p.other_deduction)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {canEdit && (
        <div className="danger-zone no-print">
          <button className="btn btn-danger-ghost" onClick={remove}>
            Delete payroll
          </button>
        </div>
      )}
    </>
  );
}
