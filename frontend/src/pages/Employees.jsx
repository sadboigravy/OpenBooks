import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, del, money, post, put, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Field, Loading, Modal, PageHeader } from '../components/ui.jsx';

const SCHEDULES = { weekly: 'Every week', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Every month' };

export function EmployeeForm({ employee, onClose, onSaved }) {
  const { notify } = useApp();
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    job_title: '',
    pay_type: 'hourly',
    pay_rate: '',
    pay_schedule: 'biweekly',
    federal_withholding_pct: 0,
    state_withholding_pct: 0,
    other_deduction: 0,
    other_deduction_label: '',
    withholding_method: 'tables',
    w4_filing_status: 'single',
    w4_multiple_jobs: false,
    w4_dependents: 0,
    w4_other_income: 0,
    w4_deductions: 0,
    w4_extra: 0,
    work_state: '',
    state_filing_status: 'single',
    state_allowances: 0,
    state_extra: 0,
    active: true,
    ...employee,
    hire_date: employee?.hire_date || '',
  });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  // New employees follow the company's tax method (Settings -> How taxes are calculated)
  useEffect(() => {
    if (employee?.id) return;
    api('/tax/method')
      .then((m) => setForm((f) => ({ ...f, withholding_method: m.payroll_default === 'tables' ? 'tables' : 'percent' })))
      .catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    try {
      const saved = employee?.id ? await put(`/employees/${employee.id}`, form) : await post('/employees', form);
      notify(`${saved.name} saved`);
      onSaved(saved);
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${employee.name}?`)) return;
    try {
      await del(`/employees/${employee.id}`);
      notify('Employee deleted');
      onSaved(null);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      wide
      title={employee?.id ? 'Edit employee' : 'Add an employee'}
      onClose={onClose}
      footer={
        <>
          {employee?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="employee-form">
            Save
          </button>
        </>
      }
    >
      <form id="employee-form" onSubmit={save}>
        <ErrorBanner error={error} />
        <h3 className="form-section">Personal info</h3>
        <div className="form-grid cols-3">
          <Field label="Full name *">
            <input value={form.name} onChange={set('name')} required autoFocus />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Phone">
            <input value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Job title">
            <input value={form.job_title} onChange={set('job_title')} />
          </Field>
          <Field label="Hire date">
            <input type="date" value={form.hire_date} onChange={set('hire_date')} />
          </Field>
          <Field label="Home address">
            <input value={form.address} onChange={set('address')} />
          </Field>
        </div>
        <h3 className="form-section">Pay</h3>
        <div className="form-grid cols-3">
          <Field label="Pay type">
            <select value={form.pay_type} onChange={set('pay_type')}>
              <option value="hourly">Hourly</option>
              <option value="salary">Salary</option>
            </select>
          </Field>
          <Field label={form.pay_type === 'hourly' ? 'Hourly rate *' : 'Annual salary *'}>
            <input type="number" step="0.01" min="0" value={form.pay_rate} onChange={set('pay_rate')} required />
          </Field>
          <Field label="Pay schedule">
            <select value={form.pay_schedule} onChange={set('pay_schedule')}>
              {Object.entries(SCHEDULES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <h3 className="form-section">Tax withholding</h3>
        <Field label="How should income tax be withheld?">
          <select value={form.withholding_method} onChange={set('withholding_method')}>
            <option value="tables">Calculate from the employee's W-4 and the tax tables</option>
            <option value="percent">Fixed percentages I enter</option>
          </select>
        </Field>
        {form.withholding_method === 'tables' ? (
          <>
            <p className="muted small">From the employee's Form W-4 (2020 or later). Social security, Medicare and unemployment come from the tax tables under Taxes → Payroll tax.</p>
            <div className="form-grid cols-3">
              <Field label="Filing status (Step 1c)">
                <select value={form.w4_filing_status} onChange={set('w4_filing_status')}>
                  <option value="single">Single or married filing separately</option>
                  <option value="married_jointly">Married filing jointly</option>
                  <option value="head_of_household">Head of household</option>
                </select>
              </Field>
              <Field label="Dependents credit (Step 3, annual)">
                <input type="number" step="0.01" min="0" value={form.w4_dependents} onChange={set('w4_dependents')} />
              </Field>
              <Field label="Other income (Step 4a, annual)">
                <input type="number" step="0.01" min="0" value={form.w4_other_income} onChange={set('w4_other_income')} />
              </Field>
              <Field label="Deductions (Step 4b, annual)">
                <input type="number" step="0.01" min="0" value={form.w4_deductions} onChange={set('w4_deductions')} />
              </Field>
              <Field label="Extra withholding (Step 4c, per paycheck)">
                <input type="number" step="0.01" min="0" value={form.w4_extra} onChange={set('w4_extra')} />
              </Field>
              <label className="checkbox" style={{ alignSelf: 'end', paddingBottom: 10 }}>
                <input type="checkbox" checked={form.w4_multiple_jobs} onChange={set('w4_multiple_jobs')} /> Step 2(c) box checked (multiple jobs)
              </label>
            </div>
            <h3 className="form-section">State</h3>
            <div className="form-grid cols-4">
              <Field label="Work state" hint="2 letters; leave blank for none">
                <input value={form.work_state} maxLength={2} onChange={(e) => setForm({ ...form, work_state: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="State filing status">
                <select value={form.state_filing_status} onChange={set('state_filing_status')}>
                  <option value="single">Single</option>
                  <option value="married_jointly">Married</option>
                  <option value="head_of_household">Head of household</option>
                </select>
              </Field>
              <Field label="State allowances / exemptions">
                <input type="number" min="0" step="1" value={form.state_allowances} onChange={set('state_allowances')} />
              </Field>
              <Field label="Extra state withholding (per paycheck)">
                <input type="number" step="0.01" min="0" value={form.state_extra} onChange={set('state_extra')} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Enter the percentages from this employee's tax forms. Social security and Medicare rates for this method are set company-wide in Settings.
            </p>
            <div className="form-grid cols-2">
              <Field label="Federal income tax (%)">
                <input type="number" step="0.01" min="0" max="100" value={form.federal_withholding_pct} onChange={set('federal_withholding_pct')} />
              </Field>
              <Field label="State income tax (%)">
                <input type="number" step="0.01" min="0" max="100" value={form.state_withholding_pct} onChange={set('state_withholding_pct')} />
              </Field>
            </div>
          </>
        )}
        <h3 className="form-section">Deductions</h3>
        <div className="form-grid">
          <Field label="Other deduction (per paycheck, after tax)">
            <input type="number" step="0.01" min="0" value={form.other_deduction} onChange={set('other_deduction')} />
          </Field>
          <Field label="Deduction name">
            <input value={form.other_deduction_label} onChange={set('other_deduction_label')} placeholder="e.g. Health plan" />
          </Field>
        </div>
        {employee?.id && (
          <label className="checkbox" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

export default function Employees() {
  const { canEdit } = useApp();
  const [params, setParams] = useSearchParams();
  const [showInactive, setShowInactive] = useState(false);
  const { data, error, loading, reload } = useApi(`/employees?include_inactive=${showInactive ? 1 : 0}`);
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    if (params.get('new') && canEdit) {
      setEditing({});
      setParams({}, { replace: true });
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader title="Employees">
        {canEdit && (
          <>
            <Link className="btn" to="/time">
              Timesheets
            </Link>
            <Link className="btn" to="/payroll/run">
              Run payroll
            </Link>
            <button className="btn btn-primary" onClick={() => setEditing({})}>
              Add an employee
            </button>
          </>
        )}
      </PageHeader>
      <div className="toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title="No employees yet">Add your team to track their time and run payroll.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Job title</th>
                <th>Pay rate</th>
                <th className="hide-sm">Pay schedule</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'inactive'}>
                  <td>
                    <Link to={`/employees/${e.id}`}>
                      <strong>{e.name}</strong>
                    </Link>
                    {e.email && <div className="small muted">{e.email}</div>}
                  </td>
                  <td className="hide-sm">{e.job_title}</td>
                  <td>
                    {money(e.pay_rate)}
                    <span className="muted">{e.pay_type === 'hourly' ? '/hr' : '/yr'}</span>
                  </td>
                  <td className="hide-sm">{SCHEDULES[e.pay_schedule]}</td>
                  <td>{e.active ? <span className="badge badge-green">Active</span> : <span className="badge badge-gray">Inactive</span>}</td>
                  <td className="row-actions">
                    {canEdit && (
                      <button className="btn btn-sm" onClick={() => setEditing(e)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EmployeeForm
          employee={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}
