import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, money, post, put, useApi, useApp } from '../lib.jsx';
import { Empty, ErrorBanner, Field, Loading, Modal, PageHeader, TaxCodeSelect } from '../components/ui.jsx';

const BLANK = { name: '', company: '', email: '', phone: '', address: '', address_line1: '', city: '', region: '', postal_code: '', country: '', tax_exempt: false, exemption_reason: '', default_tax_code_id: '', notes: '', active: true };

export function ContactForm({ kind, contact, onClose, onSaved }) {
  const { notify } = useApp();
  const [form, setForm] = useState({ ...BLANK, ...contact });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const singular = kind === 'customers' ? 'customer' : 'vendor';
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = contact?.id ? await put(`/${kind}/${contact.id}`, form) : await post(`/${kind}`, form);
      notify(`${saved.name} saved`);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${contact.name}?`)) return;
    try {
      await del(`/${kind}/${contact.id}`);
      notify(`${contact.name} deleted`);
      onSaved(null);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={contact?.id ? `Edit ${singular}` : `New ${singular}`}
      onClose={onClose}
      footer={
        <>
          {contact?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="contact-form" disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <form id="contact-form" onSubmit={save} className="form-grid">
        <ErrorBanner error={error} />
        <Field label="Name *">
          <input value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Company">
          <input value={form.company} onChange={set('company')} />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Street address" className="span-2">
          <input value={form.address_line1} onChange={set('address_line1')} placeholder={form.address && !form.address_line1 ? form.address.split('\n')[0] : ''} />
        </Field>
        <Field label="City">
          <input value={form.city} onChange={set('city')} />
        </Field>
        <Field label="State / province / region">
          <input value={form.region} onChange={set('region')} />
        </Field>
        <Field label="Postal code">
          <input value={form.postal_code} onChange={set('postal_code')} />
        </Field>
        <Field label="Country" hint="2-letter code, e.g. US, GB, CA">
          <input value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} />
        </Field>
        {kind === 'customers' && (
          <>
            <Field label="Default tax code" hint="Used for new lines on this customer's invoices">
              <TaxCodeSelect value={form.default_tax_code_id} onChange={(v) => setForm({ ...form, default_tax_code_id: v })} placeholder="Company default" />
            </Field>
            <Field label="Exemption reason / certificate no." hint={form.tax_exempt ? 'Shown on invoices and kept for audits' : ''}>
              <input value={form.exemption_reason} onChange={set('exemption_reason')} disabled={!form.tax_exempt} />
            </Field>
            <label className="checkbox span-2">
              <input type="checkbox" checked={form.tax_exempt} onChange={set('tax_exempt')} /> This customer is exempt from sales tax
            </label>
          </>
        )}
        <Field label="Notes" className="span-2">
          <textarea rows={2} value={form.notes} onChange={set('notes')} />
        </Field>
        {contact?.id && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

export default function Contacts({ kind }) {
  const { canEdit } = useApp();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const { data, error, loading, reload } = useApi(`/${kind}?include_inactive=${showInactive ? 1 : 0}&q=${encodeURIComponent(search)}`);
  const [editing, setEditing] = useState(null);
  const isCustomer = kind === 'customers';
  const title = isCustomer ? 'Customers' : 'Vendors';
  const docPath = isCustomer ? '/invoices' : '/bills';
  const total = (data || []).reduce((s, c) => s + c.open_balance, 0);

  return (
    <>
      <PageHeader title={title} subtitle={data ? `${data.length} ${title.toLowerCase()} · ${money(total)} open` : null}>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            + New {isCustomer ? 'customer' : 'vendor'}
          </button>
        )}
      </PageHeader>
      <div className="toolbar">
        <input className="search" placeholder={`Search ${title.toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="checkbox">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card">
          <Empty title={search ? 'No matches' : `No ${title.toLowerCase()} yet`}>
            {!search && canEdit && `Add your first ${isCustomer ? 'customer' : 'vendor'} to get started.`}
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Email</th>
                <th className="hide-sm">Phone</th>
                <th className="num">Open balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'inactive'}>
                  <td>
                    <Link to={`/${kind}/${c.id}`}>
                      <strong>{c.name}</strong>
                    </Link>
                    {c.company && <div className="muted small">{c.company}</div>}
                  </td>
                  <td className="hide-sm">{c.email}</td>
                  <td className="hide-sm">{c.phone}</td>
                  <td className="num">
                    {money(c.open_balance)}
                    {c.overdue_balance > 0 && <div className="small neg">{money(c.overdue_balance)} overdue</div>}
                  </td>
                  <td className="row-actions">
                    <Link className="btn btn-sm btn-ghost" to={`${docPath}?${isCustomer ? 'customer_id' : 'vendor_id'}=${c.id}`}>
                      {isCustomer ? 'Invoices' : 'Bills'}
                    </Link>
                    {canEdit && (
                      <>
                        <Link className="btn btn-sm btn-ghost" to={isCustomer ? `/invoices/new?customer_id=${c.id}` : `/bills/new?vendor_id=${c.id}`}>
                          {isCustomer ? '+ Invoice' : '+ Bill'}
                        </Link>
                        <button className="btn btn-sm" onClick={() => setEditing(c)}>
                          Edit
                        </button>
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
        <ContactForm
          kind={kind}
          contact={editing}
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
