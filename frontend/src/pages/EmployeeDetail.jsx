import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { fmtDate, money, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { EmployeeForm } from './Employees.jsx';

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = useApp();
  const { data: e, error, loading, reload } = useApi(`/employees/${id}`);
  const [editing, setEditing] = useState(false);
  if (loading && !e) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <>
      <div className="breadcrumb">
        <Link to="/employees">Employees</Link> ›
      </div>
      <div className="card contact-head">
        <div className="contact-main">
          <div className="contact-avatar">{e.name.charAt(0).toUpperCase()}</div>
          <div>
            <h1>
              {e.name} {!e.active && <span className="badge badge-gray">inactive</span>}
            </h1>
            <div className="muted">{e.job_title}</div>
            <div className="contact-meta">
              {e.email && <a href={`mailto:${e.email}`}>{e.email}</a>}
              {e.phone && <span>{e.phone}</span>}
              {e.hire_date && <span>Hired {fmtDate(e.hire_date)}</span>}
            </div>
          </div>
        </div>
        <div className="contact-side">
          <div className="contact-balances">
            <div>
              <div className="kpi-label">Pay</div>
              <div className="kpi-value small-kpi">
                {money(e.pay_rate)}
                <small className="muted">{e.pay_type === 'hourly' ? '/hr' : '/yr'}</small>
              </div>
            </div>
            <div>
              <div className="kpi-label">Gross pay YTD</div>
              <div className="kpi-value small-kpi">{money(e.ytd_gross)}</div>
            </div>
          </div>
          {canEdit && (
            <div className="page-actions">
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <Link className="btn" to={`/time?employee_id=${e.id}`}>
                Timesheet
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="detail-grid card">
        <div>
          <div className="field-label">Federal withholding</div>
          {e.federal_withholding_pct}%
        </div>
        <div>
          <div className="field-label">State withholding</div>
          {e.state_withholding_pct}%
        </div>
        <div>
          <div className="field-label">{e.other_deduction_label || 'Other deduction'}</div>
          {money(e.other_deduction)} per paycheck
        </div>
        <div>
          <div className="field-label">Net pay YTD</div>
          {money(e.ytd_net)}
        </div>
      </div>
      <h2 className="section-title">Paychecks</h2>
      {e.paychecks.length === 0 ? (
        <div className="card">
          <Empty title="No paychecks yet" />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pay date</th>
                <th className="num">Hours</th>
                <th className="num">Gross</th>
                <th className="num hide-sm">Taxes withheld</th>
                <th className="num hide-sm">Deductions</th>
                <th className="num">Net pay</th>
              </tr>
            </thead>
            <tbody>
              {e.paychecks.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/payroll/runs/${p.run_id}`)}>
                  <td>{fmtDate(p.pay_date)}</td>
                  <td className="num">{p.hours}</td>
                  <td className="num">{money(p.gross)}</td>
                  <td className="num hide-sm">{money(p.employee_taxes)}</td>
                  <td className="num hide-sm">{money(p.other_deduction)}</td>
                  <td className="num">{money(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EmployeeForm
          employee={e}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            if (saved) reload();
            else navigate('/employees');
          }}
        />
      )}
    </>
  );
}
