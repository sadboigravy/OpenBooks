import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { downloadCsv, fmtDate, money, post, put, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Field, Loading, PageHeader, Tabs } from '../components/ui.jsx';

function ChooseForm({ setup, onSaved, isAdmin }) {
  const [error, setError] = useState(null);
  async function choose(key) {
    try {
      await put('/income-tax/setup', { form: key });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="card">
      <div className="card-header">
        <h2>Which tax return does this business file?</h2>
      </div>
      <ErrorBanner error={error} />
      <div className="form-choices">
        {setup.forms.map((f) => (
          <button key={f.key} type="button" className={`choice ${setup.form === f.key ? 'selected' : ''}`} disabled={!isAdmin} onClick={() => choose(f.key)}>
            <strong>{f.name}</strong>
            <span className="muted small">{f.entity}</span>
          </button>
        ))}
      </div>
      {!isAdmin && <p className="muted small">Only an administrator can change this.</p>}
    </div>
  );
}

function CustomLines({ setup, onSaved }) {
  const [lines, setLines] = useState(setup.custom_lines.length ? setup.custom_lines : [{ code: '1', label: '', kind: 'income', note: '' }]);
  const [error, setError] = useState(null);
  const { notify } = useApp();
  const set = (i, k, v) => setLines(lines.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)));
  async function save() {
    try {
      await put('/income-tax/setup', { custom_lines: lines.filter((l) => l.code || l.label) });
      notify('Custom categories saved');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="card form-card">
      <div className="card-header">
        <h2>Your tax categories</h2>
      </div>
      <ErrorBanner error={error} />
      <div className="lines">
        <table className="table lines-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Code</th>
              <th>Name</th>
              <th style={{ width: 170 }}>Kind</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td data-label="Code">
                  <input value={l.code} onChange={(e) => set(i, 'code', e.target.value)} />
                </td>
                <td data-label="Name">
                  <input value={l.label} onChange={(e) => set(i, 'label', e.target.value)} />
                </td>
                <td data-label="Kind">
                  <select value={l.kind} onChange={(e) => set(i, 'kind', e.target.value)}>
                    <option value="income">Income</option>
                    <option value="contra">Returns / reductions of income</option>
                    <option value="cogs">Cost of goods sold</option>
                    <option value="expense">Deductible expense</option>
                  </select>
                </td>
                <td data-label="Note">
                  <input value={l.note} onChange={(e) => set(i, 'note', e.target.value)} />
                </td>
                <td>
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setLines(lines.filter((_, idx) => idx !== i))}>
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { code: String(lines.length + 1), label: '', kind: 'expense', note: '' }])}>
          Add category
        </button>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={save}>
          Save categories
        </button>
      </div>
    </div>
  );
}

function Mapping({ setup, reload, canEdit }) {
  const { notify } = useApp();
  const [error, setError] = useState(null);
  const unmapped = setup.accounts.filter((a) => !a.line).length;
  async function setLine(accountId, line) {
    try {
      await put('/income-tax/mappings', { mappings: { [accountId]: line } });
      reload();
    } catch (err) {
      setError(err);
    }
  }
  async function autoMap() {
    const r = await post('/income-tax/auto-map');
    notify(`Mapped ${r.mapped} account${r.mapped === 1 ? '' : 's'}. Review the suggestions.`);
    reload();
  }
  const groups = [
    ['income', 'Income accounts'],
    ['expense', 'Expense accounts'],
  ];
  return (
    <>
      <ErrorBanner error={error} />
      <div className="toolbar">
        <span className="muted">{unmapped ? `${unmapped} account${unmapped === 1 ? '' : 's'} not mapped` : 'All income and expense accounts are mapped'}</span>
        <span className="spacer" />
        {canEdit && unmapped > 0 && setup.form !== 'custom' && (
          <button className="btn btn-primary" onClick={autoMap}>
            Auto-map {unmapped} account{unmapped === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {groups.map(([type, title]) => (
        <div key={type} className="card table-wrap">
          <div className="card-header">
            <h2>{title}</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Tax return line</th>
                <th className="hide-sm">Suggested</th>
              </tr>
            </thead>
            <tbody>
              {setup.accounts
                .filter((a) => a.type === type)
                .map((a) => (
                  <tr key={a.id} className={a.active ? '' : 'inactive'}>
                    <td>{a.label}</td>
                    <td style={{ minWidth: 260 }}>
                      <select value={a.line || ''} disabled={!canEdit} onChange={(e) => setLine(a.id, e.target.value || null)} aria-label={`Line for ${a.name}`}>
                        <option value="">— Not mapped —</option>
                        {setup.lines.map((l) => (
                          <option key={l.code} value={l.code}>
                            {setup.form === 'custom' ? '' : `Line ${l.code}: `}
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="hide-sm small muted">
                      {a.suggested && a.suggested !== a.line && (
                        <button className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => setLine(a.id, a.suggested)}>
                          Use line {a.suggested}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

function Summary() {
  const { settings } = useApp();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, error, loading } = useApi(`/income-tax/summary?year=${year}`);
  const [open, setOpen] = useState(null);
  function exportCsv() {
    const rows = [['Line', 'Description', 'Amount', 'Account', 'Account amount']];
    data.lines.forEach((l) => {
      rows.push([l.code, l.label, l.amount, '', '']);
      l.accounts.forEach((a) => rows.push([l.code, '', '', a.account, a.amount]));
    });
    data.unmapped.forEach((u) => rows.push(['UNMAPPED', '', '', u.account, u.amount]));
    rows.push(['', 'Net profit', data.totals.net_profit, '', '']);
    downloadCsv(`tax-summary-${data.form}-${year}.csv`, rows);
  }
  return (
    <>
      <div className="card report-controls no-print">
        <Field label="Tax year">
          <input type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />
        </Field>
        <span className="spacer" />
        <button className="btn" onClick={() => window.print()}>
          Print / PDF
        </button>
        <button className="btn" disabled={!data} onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          {data.unmapped.length > 0 && (
            <div className="alert alert-warn no-print">
              {data.unmapped.length} account{data.unmapped.length === 1 ? ' has' : 's have'} activity but no tax line: {data.unmapped.map((u) => u.account).join(', ')}.{' '}
              <Link to="/taxes/income?tab=mapping">Map them</Link> so the summary is complete.
            </div>
          )}
          <div className="card report-paper">
            <div className="report-title">
              <div className="muted">{settings.company_name}</div>
              <h2>{data.form_name}</h2>
              <div className="muted">
                Tax year {fmtDate(data.start)} – {fmtDate(data.end)} · prepared from the books
              </div>
            </div>
            <table className="table report-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>{data.form === 'custom' ? 'Code' : 'Line'}</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <Fragment key={l.code}>
                    <tr className={l.accounts.length ? 'clickable' : ''} onClick={() => l.accounts.length && setOpen(open === l.code ? null : l.code)}>
                      <td className="mono">{l.code}</td>
                      <td>
                        {l.accounts.length > 0 && (open === l.code ? '▾ ' : '▸ ')}
                        {l.label}
                        {l.note && l.amount !== 0 && <div className="small muted">{l.note}</div>}
                      </td>
                      <td className="num">{l.amount ? money(l.kind === 'contra' ? -l.amount : l.amount) : '—'}</td>
                    </tr>
                    {open === l.code &&
                      l.accounts.map((a) => (
                        <tr key={a.account_id} className="subrow">
                          <td />
                          <td className="indent small">{a.account}</td>
                          <td className="num small">{money(a.amount)}</td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
                <tr className="total-row">
                  <td />
                  <td>Gross income (after returns)</td>
                  <td className="num">{money(data.totals.gross_income)}</td>
                </tr>
                <tr className="total-row">
                  <td />
                  <td>Gross profit</td>
                  <td className="num">{money(data.totals.gross_profit)}</td>
                </tr>
                <tr className="total-row">
                  <td />
                  <td>Total deductions</td>
                  <td className="num">{money(data.totals.deductions)}</td>
                </tr>
                <tr className="grand-row">
                  <td />
                  <td>Net profit (before tax adjustments)</td>
                  <td className="num">{money(data.totals.net_profit)}</td>
                </tr>
              </tbody>
            </table>
            <ul className="notes small muted">
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function IncomeTax() {
  const { user, canEdit } = useApp();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const { data: setup, error, loading, reload } = useApi('/income-tax/setup');
  if (loading && !setup) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  const tab = params.get('tab') || (setup.form ? 'summary' : 'return');
  return (
    <>
      <PageHeader title="Income tax" subtitle="Year-end figures grouped the way your business tax return asks for them" />
      <div className="alert alert-info small">
        This is a preparation aid built from your books, not a tax return. It doesn't calculate tax owed or file anything. Share the summary with your tax preparer and
        confirm line numbers against the current year's form.
      </div>
      <div className="toolbar">
        <Tabs
          tabs={[
            ['summary', 'Tax summary'],
            ['mapping', 'Account mapping'],
            ['return', 'Return type'],
          ]}
          value={setup.form ? tab : 'return'}
          onChange={(t) => setParams({ tab: t })}
        />
      </div>
      {!setup.form || tab === 'return' ? (
        <>
          <ChooseForm
            setup={setup}
            onSaved={() => {
              reload();
              setParams({ tab: 'mapping' });
            }}
            isAdmin={isAdmin}
          />
          {setup.form === 'custom' && isAdmin && <CustomLines setup={setup} onSaved={reload} />}
        </>
      ) : tab === 'mapping' ? (
        setup.lines.length ? (
          <Mapping setup={setup} reload={reload} canEdit={canEdit} />
        ) : (
          <div className="card">
            <Empty title="No categories yet">Add your tax categories under Return type.</Empty>
          </div>
        )
      ) : (
        <Summary />
      )}
    </>
  );
}
