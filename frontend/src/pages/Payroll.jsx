import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmtDate, money, post, today, useApi, useApp } from '../lib.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, isPayFromAccount } from '../components/ui.jsx';

function PayLiabilities({ owed, onClose, onDone }) {
  const { accounts, notify } = useApp();
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState({ date: today(), account_id: defaultBank, amount: owed, reference: '', memo: 'Payroll tax payment' });
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    try {
      await post('/payroll/liabilities/pay', form);
      notify('Payroll liability payment recorded');
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      title="Pay payroll taxes & withholdings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="liab-form">
            Record payment
          </button>
        </>
      }
    >
      <form id="liab-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Payment date *">
          <input type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field label="Amount *" hint={`Currently owed: ${money(owed)}`}>
          <input type="number" step="0.01" min="0.01" max={owed} value={form.amount} onChange={set('amount')} required />
        </Field>
        <Field label="Paid from *" className="span-2">
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={isPayFromAccount} required />
        </Field>
        <Field label="Reference / confirmation no.">
          <input value={form.reference} onChange={set('reference')} />
        </Field>
        <Field label="Memo">
          <input value={form.memo} onChange={set('memo')} />
        </Field>
      </form>
    </Modal>
  );
}

export default function Payroll() {
  const { canEdit } = useApp();
  const navigate = useNavigate();
  const runs = useApi('/payroll/runs');
  const liabilities = useApi('/payroll/liabilities');
  const [paying, setPaying] = useState(false);

  return (
    <>
      <PageHeader title="Payroll" subtitle="Pay your team and keep track of taxes withheld">
        {canEdit && (
          <>
            <Link className="btn" to="/time">
              Timesheets
            </Link>
            <Link className="btn btn-primary" to="/payroll/run">
              Run payroll
            </Link>
          </>
        )}
      </PageHeader>
      <div className="kpi-grid kpi-grid-3">
        <div className="card kpi">
          <div className="kpi-label">Taxes & withholdings owed</div>
          <div className={`kpi-value ${liabilities.data?.balance > 0 ? 'warn' : ''}`}>{liabilities.data ? money(liabilities.data.balance) : '—'}</div>
          {canEdit && liabilities.data?.balance > 0 && (
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setPaying(true)}>
              Pay taxes
            </button>
          )}
        </div>
        <div className="card kpi">
          <div className="kpi-label">Last payroll</div>
          <div className="kpi-value">{runs.data?.[0] ? money(runs.data[0].net) : '—'}</div>
          <div className="kpi-sub">{runs.data?.[0] ? `net pay on ${fmtDate(runs.data[0].pay_date)}` : 'No payrolls yet'}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Payroll cost this year</div>
          <div className="kpi-value">
            {money((runs.data || []).filter((r) => r.pay_date.slice(0, 4) === today().slice(0, 4)).reduce((s, r) => s + r.total_cost, 0))}
          </div>
          <div className="kpi-sub">gross pay + employer taxes</div>
        </div>
      </div>
      <div className="alert alert-info">
        OpenBooks calculates paychecks from the withholding rates on each employee and the payroll tax rates in Settings. It does not file returns or include
        government tax tables, so check rates with your tax authority or accountant.
      </div>
      <ErrorBanner error={runs.error} />
      {runs.loading && !runs.data ? (
        <Loading />
      ) : runs.data.length === 0 ? (
        <div className="card">
          <Empty title="No payrolls yet">{canEdit && <Link to="/payroll/run">Run your first payroll</Link>}</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <div className="card-header">
            <h2>Payroll history</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Pay date</th>
                <th>Pay period</th>
                <th className="num hide-sm">Employees</th>
                <th className="num">Gross pay</th>
                <th className="num hide-sm">Employer taxes</th>
                <th className="num">Net pay</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/payroll/runs/${r.id}`)}>
                  <td>{fmtDate(r.pay_date)}</td>
                  <td>
                    {fmtDate(r.period_start)} – {fmtDate(r.period_end)}
                  </td>
                  <td className="num hide-sm">{r.employees}</td>
                  <td className="num">{money(r.gross)}</td>
                  <td className="num hide-sm">{money(r.employer_taxes)}</td>
                  <td className="num">{money(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paying && (
        <PayLiabilities
          owed={liabilities.data.balance}
          onClose={() => setPaying(false)}
          onDone={() => {
            setPaying(false);
            liabilities.reload();
          }}
        />
      )}
    </>
  );
}
