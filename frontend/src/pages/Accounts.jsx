import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, money, post, put, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Loading, Modal, PageHeader } from '../components/ui.jsx';

const TYPES = [
  ['asset', 'Assets'],
  ['liability', 'Liabilities'],
  ['equity', 'Equity'],
  ['income', 'Income'],
  ['expense', 'Expenses'],
];
const pretty = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function AccountForm({ account, subtypes, onClose, onSaved }) {
  const { notify } = useApp();
  const [form, setForm] = useState({ code: '', name: '', type: 'expense', subtype: 'expense', description: '', active: true, ...account });
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    try {
      account?.id ? await put(`/accounts/${account.id}`, form) : await post('/accounts', form);
      notify('Account saved');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete account ${account.label}?`)) return;
    try {
      await del(`/accounts/${account.id}`);
      notify('Account deleted');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={account?.id ? 'Edit account' : 'New account'}
      onClose={onClose}
      footer={
        <>
          {account?.id && !account.is_system && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="account-form">
            Save
          </button>
        </>
      }
    >
      <form id="account-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        {account?.is_system && <div className="alert alert-info span-2">This is a system account used automatically by invoices, bills or sales tax. You can rename it but not change its type.</div>}
        <Field label="Account number *">
          <input value={form.code} onChange={(e) => set('code', e.target.value)} required autoFocus />
        </Field>
        <Field label="Name *">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </Field>
        <Field label="Account type *">
          <select value={form.type} disabled={account?.is_system} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, subtype: subtypes[e.target.value][0] }))}>
            {TYPES.map(([v]) => (
              <option key={v} value={v}>
                {pretty(v)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Detail type *" hint={form.subtype === 'bank' || form.subtype === 'credit_card' ? 'Appears in Banking' : null}>
          <select value={form.subtype} disabled={account?.is_system} onChange={(e) => set('subtype', e.target.value)}>
            {(subtypes[form.type] || []).map((s) => (
              <option key={s} value={s}>
                {pretty(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" className="span-2">
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {account?.id && !account.is_system && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

export default function Accounts() {
  const { canEdit, refreshAccounts } = useApp();
  const [showInactive, setShowInactive] = useState(false);
  const { data, error, loading, reload } = useApi(`/accounts?include_inactive=${showInactive ? 1 : 0}`);
  const subtypes = useApi('/accounts/subtypes');
  const [editing, setEditing] = useState(null);

  if ((loading && !data) || !subtypes.data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle="Every category your money is tracked in">
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            + New account
          </button>
        )}
      </PageHeader>
      <div className="toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      {TYPES.map(([type, label]) => {
        const rows = data.filter((a) => a.type === type);
        if (!rows.length) return null;
        return (
          <div key={type} className="card table-wrap">
            <div className="card-header">
              <h2>{label}</h2>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Number</th>
                  <th>Name</th>
                  <th className="hide-sm">Detail type</th>
                  <th className="num">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.active ? '' : 'inactive'}>
                    <td className="mono">{a.code}</td>
                    <td>
                      {a.name} {a.is_system && <span className="badge badge-gray">system</span>} {!a.active && <span className="badge badge-gray">inactive</span>}
                      {a.description && <div className="small muted">{a.description}</div>}
                    </td>
                    <td className="hide-sm">{pretty(a.subtype)}</td>
                    <td className="num">{money(a.balance)}</td>
                    <td className="row-actions">
                      <Link className="btn btn-sm btn-ghost" to={`/reports/general-ledger?account_id=${a.id}`}>
                        Ledger
                      </Link>
                      {canEdit && (
                        <button className="btn btn-sm" onClick={() => setEditing(a)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {editing && (
        <AccountForm
          account={editing}
          subtypes={subtypes.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            refreshAccounts();
          }}
        />
      )}
    </>
  );
}
