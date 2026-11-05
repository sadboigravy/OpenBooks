import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDate, money, post, put, del, today, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Tabs } from '../components/ui.jsx';

const STATUSES = [
  ['single', 'Single or married filing separately'],
  ['married_jointly', 'Married filing jointly'],
  ['head_of_household', 'Head of household'],
];
const KIND_LABEL = {
  income_tax: 'Income tax withholding',
  social_security: 'Social security',
  medicare: 'Medicare',
  futa: 'Federal unemployment (FUTA)',
  suta: 'State unemployment (SUTA)',
};
const list = (arr) => (arr || []).join(', ');
const parseList = (text) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);

/** Structured editor for one table's data, by kind. */
function TableEditor({ table, onClose, onSaved }) {
  const [data, setData] = useState(table.data);
  const [text, setText] = useState(() => ({
    rates: list(table.data.rates),
    ...Object.fromEntries(Object.entries(table.data.brackets || {}).map(([k, v]) => [`b_${k}`, list(v)])),
  }));
  const [source, setSource] = useState(table.source);
  const [error, setError] = useState(null);
  const isFed = table.jurisdiction === 'US-FED';
  const method = data.method;

  async function save(e) {
    e.preventDefault();
    setError(null);
    let out = { ...data };
    if (table.kind === 'income_tax' && (method === 'w4_2020' || method === 'brackets')) {
      out.rates = parseList(text.rates || '');
      const statuses = method === 'w4_2020' ? STATUSES.map((s) => s[0]) : Object.keys(out.brackets || { single: [] });
      out.brackets = Object.fromEntries(statuses.map((s) => [s, parseList(text[`b_${s}`] || '')]));
    }
    try {
      await put(`/payroll-tax/tables/${table.id}`, { data: out, source });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  const num = (key, label, hint) => (
    <Field label={label} hint={hint}>
      <input type="number" step="any" value={data[key] ?? ''} onChange={(e) => setData({ ...data, [key]: e.target.value === '' ? '' : Number(e.target.value) })} />
    </Field>
  );

  return (
    <Modal
      wide
      title={`Edit ${table.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="table-form">
            Save table
          </button>
        </>
      }
    >
      <form id="table-form" onSubmit={save}>
        <ErrorBanner error={error} />
        <div className="alert alert-warn small">Saving changes marks this table as unverified until an administrator checks it again.</div>
        {table.kind === 'income_tax' && !isFed && (
          <Field label="Method">
            <select
              value={method}
              onChange={(e) => {
                const m = e.target.value;
                setData(m === 'flat' ? { method: 'flat', rate: 0, standard_deduction: 0, allowance_per_exemption: 0 } : m === 'brackets' ? { method: 'brackets', rates: [], brackets: { single: [], married_jointly: [] }, standard_deduction: { single: 0, married_jointly: 0 }, allowance_per_exemption: 0 } : { method: 'none' });
                setText({ rates: '', b_single: '', b_married_jointly: '' });
              }}
            >
              <option value="none">No income tax on wages</option>
              <option value="flat">Flat rate</option>
              <option value="brackets">Brackets</option>
            </select>
          </Field>
        )}
        {table.kind === 'income_tax' && method === 'w4_2020' && (
          <>
            <h3 className="form-section">Standard deduction (annual, by filing status)</h3>
            <div className="form-grid cols-3">
              {STATUSES.map(([k, l]) => (
                <Field key={k} label={l}>
                  <input type="number" value={data.standard_deduction?.[k] ?? ''} onChange={(e) => setData({ ...data, standard_deduction: { ...data.standard_deduction, [k]: Number(e.target.value) } })} />
                </Field>
              ))}
            </div>
          </>
        )}
        {table.kind === 'income_tax' && (method === 'w4_2020' || method === 'brackets') && (
          <>
            <h3 className="form-section">Brackets</h3>
            <Field label="Rates (%) from lowest to highest, comma separated" hint="e.g. 10, 12, 22, 24, 32, 35, 37">
              <input value={text.rates || ''} onChange={(e) => setText({ ...text, rates: e.target.value })} />
            </Field>
            {(method === 'w4_2020' ? STATUSES : STATUSES.filter(([k]) => data.brackets && k in data.brackets)).map(([k, l]) => (
              <Field key={k} label={`${l}: upper limit of each bracket except the top one (annual taxable income)`}>
                <input value={text[`b_${k}`] || ''} onChange={(e) => setText({ ...text, [`b_${k}`]: e.target.value })} />
              </Field>
            ))}
            {method === 'brackets' && (
              <div className="form-grid cols-3">
                <Field label="Standard deduction (single)">
                  <input type="number" value={data.standard_deduction?.single ?? 0} onChange={(e) => setData({ ...data, standard_deduction: { ...data.standard_deduction, single: Number(e.target.value) } })} />
                </Field>
                <Field label="Standard deduction (married)">
                  <input type="number" value={data.standard_deduction?.married_jointly ?? 0} onChange={(e) => setData({ ...data, standard_deduction: { ...data.standard_deduction, married_jointly: Number(e.target.value) } })} />
                </Field>
                {num('allowance_per_exemption', 'Allowance per exemption (annual)')}
              </div>
            )}
          </>
        )}
        {table.kind === 'income_tax' && method === 'flat' && (
          <div className="form-grid cols-3">
            {num('rate', 'Rate (%)')}
            {num('standard_deduction', 'Annual standard deduction')}
            {num('allowance_per_exemption', 'Allowance per exemption (annual)')}
          </div>
        )}
        {['social_security', 'futa', 'suta'].includes(table.kind) && (
          <div className="form-grid">
            {num('rate', 'Rate (%)', table.kind === 'suta' ? 'Your employer rate from the state' : null)}
            {num('wage_base', 'Annual wage base', 'Wages above this each year are not taxed')}
          </div>
        )}
        {table.kind === 'medicare' && (
          <div className="form-grid cols-3">
            {num('rate', 'Rate (%) – employee and employer each')}
            {num('additional_rate', 'Additional Medicare rate (%) – employee only')}
            {num('additional_threshold', 'Additional Medicare threshold')}
          </div>
        )}
        <Field label="Source" hint="Where these figures come from (publication, notice, letter)">
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function AddTable({ year, onClose, onSaved }) {
  const [form, setForm] = useState({ state: '', kind: 'income_tax', method: 'flat' });
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    const data =
      form.kind === 'suta'
        ? { rate: 0, wage_base: 0 }
        : form.method === 'none'
          ? { method: 'none' }
          : form.method === 'flat'
            ? { method: 'flat', rate: 0, standard_deduction: 0, allowance_per_exemption: 0 }
            : { method: 'brackets', rates: [0, 0], brackets: { single: [10000], married_jointly: [20000] }, standard_deduction: { single: 0, married_jointly: 0 }, allowance_per_exemption: 0 };
    try {
      const t = await post('/payroll-tax/tables', { tax_year: year, jurisdiction: `US-${form.state.toUpperCase()}`, kind: form.kind, data });
      onSaved(t);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal
      title={`Add a state table for ${year}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="add-table-form">
            Add and edit
          </button>
        </>
      }
    >
      <form id="add-table-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="State (2 letters) *">
          <input value={form.state} maxLength={2} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} required autoFocus />
        </Field>
        <Field label="Table">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="income_tax">State income tax withholding</option>
            <option value="suta">State unemployment (SUTA) – your employer rate</option>
          </select>
        </Field>
        {form.kind === 'income_tax' && (
          <Field label="Method" className="span-2">
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="flat">Flat rate</option>
              <option value="brackets">Brackets</option>
              <option value="none">No income tax on wages</option>
            </select>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function Summary({ table }) {
  const d = table.data;
  if (table.kind === 'income_tax') {
    if (d.method === 'none') return <span className="muted">No income tax on wages</span>;
    if (d.method === 'flat') return <span>{d.rate}% flat</span>;
    const sd = d.standard_deduction || {};
    return (
      <span>
        {list(d.rates)}% · std. deduction {typeof sd === 'object' ? Object.values(sd).map((v) => money(v).replace('.00', '')).join(' / ') : money(sd)}
      </span>
    );
  }
  if (table.kind === 'medicare') return <span>{d.rate}% each · +{d.additional_rate}% over {money(d.additional_threshold).replace('.00', '')}</span>;
  return (
    <span>
      {d.rate}% up to {money(d.wage_base).replace('.00', '')}
    </span>
  );
}

function Tables() {
  const { user, notify } = useApp();
  const isAdmin = user.role === 'admin';
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, error, loading, reload } = useApi(`/payroll-tax/tables?year=${year}`);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  const unverified = data.tables.filter((t) => !t.verified).length;

  async function verify(t, verified) {
    await post(`/payroll-tax/tables/${t.id}/verify`, { verified });
    notify(verified ? 'Marked verified' : 'Marked unverified');
    reload();
  }
  async function copyYear() {
    const r = await post('/payroll-tax/tables/copy-year', { from_year: year, to_year: year + 1 });
    notify(`Copied ${r.created} tables to ${year + 1}. Update and verify them before use.`);
    setYear(year + 1);
  }

  return (
    <>
      <div className="toolbar">
        <label className="field" style={{ minWidth: 140 }}>
          <span className="field-label">Tax year</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[...new Set([...data.years, year, new Date().getFullYear()])]
              .sort((a, b) => b - a)
              .map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
          </select>
        </label>
        <span className="spacer" />
        {isAdmin && (
          <>
            <button className="btn" onClick={() => setAdding(true)}>
              Add state table
            </button>
            <button className="btn" onClick={copyYear} disabled={!data.tables.length}>
              Copy to {year + 1}
            </button>
          </>
        )}
      </div>
      {unverified > 0 && (
        <div className="alert alert-warn">
          {unverified} table{unverified === 1 ? '' : 's'} for {year} not yet verified. The built-in figures are a starting point. Check each against the official
          source for the year (for federal: IRS Publication 15-T and the SSA wage base), correct anything that differs, then mark it verified.
        </div>
      )}
      {data.tables.length === 0 ? (
        <div className="card">
          <Empty title={`No tables for ${year}`}>{isAdmin && 'Copy the previous year forward, then update the figures.'}</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Jurisdiction</th>
                <th>Table</th>
                <th className="hide-sm">Figures</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.tables.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.jurisdiction === 'US-FED' ? 'Federal' : t.jurisdiction.slice(3)}</td>
                  <td>
                    {KIND_LABEL[t.kind]}
                    {t.source && <div className="small muted">{t.source}</div>}
                  </td>
                  <td className="hide-sm small">
                    <Summary table={t} />
                  </td>
                  <td>
                    {t.verified ? (
                      <span className="badge badge-green" title={`by ${t.verified_by} on ${fmtDate(t.verified_at?.slice(0, 10))}`}>
                        Verified
                      </span>
                    ) : (
                      <span className="badge badge-amber">Unverified</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {isAdmin && (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditing(t)}>
                          Edit
                        </button>
                        {t.verified ? (
                          <button className="btn btn-sm btn-ghost" onClick={() => verify(t, false)}>
                            Unverify
                          </button>
                        ) : (
                          <button className="btn btn-sm btn-primary" onClick={() => window.confirm(`Confirm you have checked "${t.name}" against the official source for ${t.tax_year}?`) && verify(t, true)}>
                            Mark verified
                          </button>
                        )}
                        {!t.builtin && (
                          <button
                            className="btn btn-sm btn-danger-ghost"
                            onClick={async () => {
                              if (!window.confirm(`Delete ${t.name}?`)) return;
                              await del(`/payroll-tax/tables/${t.id}`);
                              reload();
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TableEditor
          table={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notify('Table saved. Verify it before running payroll.');
            reload();
          }}
        />
      )}
      {adding && (
        <AddTable
          year={year}
          onClose={() => setAdding(false)}
          onSaved={(t) => {
            setAdding(false);
            reload();
            setEditing(t);
          }}
        />
      )}
    </>
  );
}

function Liability() {
  const { settings } = useApp();
  const [range, setRange] = useState({ start: `${today().slice(0, 4)}-01-01`, end: today() });
  const { data, error, loading } = useApi(`/payroll-tax/liability?start=${range.start}&end=${range.end}`);
  return (
    <>
      <div className="card report-controls no-print">
        <Field label="From">
          <input type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} />
        </Field>
        <span className="spacer" />
        <Link className="btn" to="/payroll">
          Pay payroll taxes
        </Link>
        <button className="btn" onClick={() => window.print()}>
          Print / PDF
        </button>
      </div>
      <ErrorBanner error={error} />
      <div className="card report-paper">
        <div className="report-title">
          <div className="muted">{settings.company_name}</div>
          <h2>Payroll Tax Liability</h2>
          <div className="muted">
            Paychecks dated {fmtDate(range.start)} – {fmtDate(range.end)}
          </div>
        </div>
        {loading && !data ? (
          <Loading />
        ) : data.paychecks === 0 ? (
          <Empty title="No paychecks in this period" />
        ) : (
          <table className="table report-table">
            <tbody>
              <tr className="section-row">
                <td>Wages</td>
                <td className="num">{data.paychecks} paychecks</td>
              </tr>
              <tr>
                <td className="indent">Gross wages</td>
                <td className="num">{money(data.gross_wages)}</td>
              </tr>
              <tr>
                <td className="indent">Net pay</td>
                <td className="num">{money(data.net_pay)}</td>
              </tr>
              <tr className="section-row">
                <td colSpan={2}>Taxes</td>
              </tr>
              {data.lines.map((l) => (
                <tr key={l.name}>
                  <td className="indent">
                    {l.name} <span className="muted small">({l.paid_by === 'employee' ? 'withheld' : 'employer'})</span>
                  </td>
                  <td className="num">{money(l.amount)}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Withheld from employees</td>
                <td className="num">{money(data.total_employee)}</td>
              </tr>
              <tr className="total-row">
                <td>Employer taxes</td>
                <td className="num">{money(data.total_employer)}</td>
              </tr>
              <tr className="grand-row">
                <td>Total payroll taxes</td>
                <td className="num">{money(data.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export default function PayrollTax() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'tables';
  return (
    <>
      <PageHeader title="Payroll tax" subtitle="Tax tables used to calculate paychecks, and what you owe" />
      <div className="alert alert-info small">
        OpenBooks calculates withholding from these tables and each employee's W-4 details. It does not file returns or deposit taxes for you. You are responsible for
        keeping the tables current and checking them each year.
      </div>
      <div className="toolbar">
        <Tabs
          tabs={[
            ['tables', 'Tax tables'],
            ['liability', 'Liability report'],
          ]}
          value={tab}
          onChange={(t) => setParams({ tab: t })}
        />
      </div>
      {tab === 'tables' ? <Tables /> : <Liability />}
    </>
  );
}
