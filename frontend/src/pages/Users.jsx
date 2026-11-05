import { useState } from 'react';
import { post, put, useApi, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Loading, Modal, PageHeader } from '../components/ui.jsx';

const ROLE_HELP = {
  admin: 'Full access, including settings and users',
  accountant: 'Can create and edit all transactions',
  viewer: 'Read-only access to everything',
};

function UserForm({ user, onClose, onSaved }) {
  const { notify } = useApp();
  const [form, setForm] = useState({ name: '', email: '', role: 'accountant', active: true, ...user, password: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    try {
      const payload = { ...form };
      if (user?.id && !payload.password) delete payload.password;
      user?.id ? await put(`/users/${user.id}`, payload) : await post('/users', payload);
      notify('User saved');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={user?.id ? 'Edit user' : 'Invite user'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="user-form">
            Save
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={save}>
        <ErrorBanner error={error} />
        <Field label="Name *">
          <input value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Email *">
          <input type="email" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="Role" hint={ROLE_HELP[form.role]}>
          <select value={form.role} onChange={set('role')}>
            <option value="admin">Administrator</option>
            <option value="accountant">Accountant</option>
            <option value="viewer">Viewer (read-only)</option>
          </select>
        </Field>
        <Field label={user?.id ? 'New password' : 'Password *'} hint={user?.id ? 'Leave blank to keep the current password' : 'At least 8 characters'}>
          <input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} required={!user?.id} />
        </Field>
        {user?.id && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={form.active} onChange={set('active')} /> Active (can sign in)
          </label>
        )}
      </form>
    </Modal>
  );
}

export default function Users() {
  const { user: me } = useApp();
  const { data, error, loading, reload } = useApi('/users');
  const [editing, setEditing] = useState(null);
  if (loading && !data) return <Loading />;
  return (
    <>
      <PageHeader title="Users" subtitle="People who can sign in to these books">
        <button className="btn btn-primary" onClick={() => setEditing({})}>
          + Add user
        </button>
      </PageHeader>
      <ErrorBanner error={error} />
      {data && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'inactive'}>
                  <td>
                    {u.name} {u.id === me.id && <span className="badge badge-blue">you</span>}
                  </td>
                  <td>{u.email}</td>
                  <td className="capitalize">{u.role}</td>
                  <td>{u.active ? <span className="badge badge-green">Active</span> : <span className="badge badge-gray">Disabled</span>}</td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setEditing(u)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserForm
          user={editing}
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
