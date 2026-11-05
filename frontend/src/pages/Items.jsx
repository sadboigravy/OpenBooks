import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, money, post, put, useApi, useApp } from '../lib.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, TaxCodeSelect } from '../components/ui.jsx';

function ItemForm({ item, onClose, onSaved }) {
  const { accounts, notify, taxSetup } = useApp();
  const defaultIncome = accounts.find((a) => a.active && a.type === 'income')?.id || '';
  const [form, setForm] = useState({
    name: '',
    type: 'service',
    sku: '',
    description: '',
    price: '',
    income_account_id: defaultIncome,
    cost: '',
    expense_account_id: '',
    taxable: true,
    active: true,
    sales_tax_code_id: '',
    purchase_tax_code_id: '',
    stripe_tax_code: '',
    ...item,
  });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    try {
      item?.id ? await put(`/items/${item.id}`, form) : await post('/items', form);
      notify(`${form.name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${item.name}?`)) return;
    try {
      await del(`/items/${item.id}`);
      notify('Deleted');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={item?.id ? 'Edit product/service' : 'New product/service'}
      onClose={onClose}
      footer={
        <>
          {item?.id && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="item-form">
            Save
          </button>
        </>
      }
    >
      <form id="item-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Type">
          <select value={form.type} onChange={set('type')}>
            <option value="service">Service</option>
            <option value="non_inventory">Non-inventory product</option>
          </select>
        </Field>
        <Field label="SKU">
          <input value={form.sku} onChange={set('sku')} />
        </Field>
        <Field label="Name *" className="span-2">
          <input value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Description on sales forms" className="span-2">
          <textarea rows={2} value={form.description} onChange={set('description')} />
        </Field>
        <Field label="Sales price / rate">
          <input type="number" step="0.01" min="0" value={form.price} onChange={set('price')} />
        </Field>
        <Field label="Income account *">
          <AccountSelect value={form.income_account_id} onChange={(v) => setForm({ ...form, income_account_id: v })} filter={(a) => a.type === 'income'} required />
        </Field>
        <Field label="Purchase cost">
          <input type="number" step="0.01" min="0" value={form.cost} onChange={set('cost')} />
        </Field>
        <Field label="Expense account">
          <AccountSelect value={form.expense_account_id} onChange={(v) => setForm({ ...form, expense_account_id: v })} filter={(a) => a.type === 'expense'} placeholder="— None —" />
        </Field>
        <label className="checkbox span-2">
          <input type="checkbox" checked={form.taxable} onChange={set('taxable')} /> Taxable
        </label>
        {form.taxable && (
          <>
            <Field label="Sales tax code" hint="Leave as default to use the customer's or company default">
              <TaxCodeSelect value={form.sales_tax_code_id} onChange={(v) => setForm({ ...form, sales_tax_code_id: v })} placeholder="Default" />
            </Field>
            <Field label="Purchase tax code">
              <TaxCodeSelect value={form.purchase_tax_code_id} onChange={(v) => setForm({ ...form, purchase_tax_code_id: v })} direction="purchases" placeholder="Default" />
            </Field>
            {taxSetup.settings.tax_provider === 'stripe_tax' && (
              <Field label="Stripe product tax code" hint="e.g. txcd_99999999 (general tangible goods)" className="span-2">
                <input value={form.stripe_tax_code} onChange={set('stripe_tax_code')} placeholder="Company default" />
              </Field>
            )}
          </>
        )}
        {item?.id && (
          <label className="checkbox">
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active
          </label>
        )}
      </form>
    </Modal>
  );
}

export default function Items() {
  const { canEdit, refreshItems } = useApp();
  const [params, setParams] = useSearchParams();
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useApi(`/items?include_inactive=${showInactive ? 1 : 0}`);
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    if (params.get('new') && canEdit) {
      setEditing({});
      setParams({}, { replace: true });
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (data || []).filter((i) => !search || `${i.name} ${i.sku} ${i.description}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <PageHeader title="Products and services" subtitle="Things you sell. Picking one on an invoice fills in the description, rate and income account.">
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            New
          </button>
        )}
      </PageHeader>
      <div className="toolbar">
        <input className="search" placeholder="Find products and services" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="checkbox">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty title="No products or services yet">Add the services and products you sell to speed up invoicing.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">SKU</th>
                <th>Type</th>
                <th className="hide-sm">Income account</th>
                <th className="num">Price</th>
                <th className="num hide-sm">Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'inactive'}>
                  <td>
                    <strong>{i.name}</strong>
                    {i.description && <div className="small muted">{i.description}</div>}
                  </td>
                  <td className="hide-sm">{i.sku}</td>
                  <td>{i.type === 'service' ? 'Service' : 'Non-inventory'}</td>
                  <td className="hide-sm">{i.income_account}</td>
                  <td className="num">{money(i.price)}</td>
                  <td className="num hide-sm">{i.cost ? money(i.cost) : ''}</td>
                  <td className="row-actions">
                    {canEdit && (
                      <button className="btn btn-sm" onClick={() => setEditing(i)}>
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
        <ItemForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            refreshItems();
          }}
        />
      )}
    </>
  );
}
