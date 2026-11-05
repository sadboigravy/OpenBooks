import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, closeTo, fmtDate, money, post, round2, today, useApp } from '../lib.jsx';
import { AccountSelect, Empty, Field, Loading, Tabs, isPayFromAccount } from '../components/ui.jsx';
import { TxnScreen } from '../components/shell.jsx';

export default function PayBills() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { accounts, notify } = useApp();
  const defaultBank = useMemo(() => accounts.find((a) => a.active && a.subtype === 'bank')?.id || '', [accounts]);
  const [form, setForm] = useState({ account_id: defaultBank, date: today(), method: 'Check' });
  const [bills, setBills] = useState(null);
  const [applied, setApplied] = useState({});
  const [refs, setRefs] = useState({});
  const [filter, setFilter] = useState(params.get('vendor_id') ? 'vendor' : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const account = accounts.find((a) => a.id === form.account_id);

  const load = () =>
    api('/bills?status=unpaid').then((list) => {
      const sorted = [...list].sort((a, b) => a.due_date.localeCompare(b.due_date));
      setBills(sorted);
      const pre = Number(params.get('bill_id'));
      const target = sorted.find((b) => b.id === pre);
      setApplied(target ? { [target.id]: target.balance } : {});
      setRefs({});
    });
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const vendorFilter = Number(params.get('vendor_id'));
  const visible = (bills || []).filter((b) => (filter === 'overdue' ? b.status === 'overdue' : filter === 'vendor' ? b.vendor_id === vendorFilter : true));
  const total = round2(Object.values(applied).reduce((s, v) => s + Number(v || 0), 0));
  const count = Object.values(applied).filter((v) => Number(v) > 0).length;

  async function save(mode) {
    setBusy(true);
    setError(null);
    try {
      const applications = Object.entries(applied)
        .filter(([, v]) => Number(v) > 0)
        .map(([bill_id, amount]) => ({ bill_id: Number(bill_id), amount, reference: refs[bill_id] || '' }));
      const r = await post('/bills/pay', { ...form, applications });
      notify(`Paid ${r.paid} bill${r.paid === 1 ? '' : 's'} · ${money(r.total)}`);
      setBusy(false);
      if (mode === 'new') load();
      else closeTo(navigate, location, '/expenses');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const allChecked = visible.length > 0 && visible.every((b) => Number(applied[b.id]) > 0);

  return (
    <TxnScreen title="Pay bills" fallback="/bills" headline={{ label: 'Total payment', amount: total }} onSave={save} busy={busy} error={error} disabled={!count} saveLabel={`Pay ${count || ''} bill${count === 1 ? '' : 's'} & close`}>
      <div className="form-grid cols-4">
        <Field label="Payment account *" className="span-2" hint={account ? `Balance ${money(account.balance)}` : null}>
          <AccountSelect value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} filter={isPayFromAccount} required />
        </Field>
        <Field label="Payment date *">
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </Field>
        <Field label="Method">
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {['Check', 'ACH / bank transfer', 'Credit card', 'Cash', 'Other'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="toolbar" style={{ marginTop: 18 }}>
        <Tabs
          tabs={[['', 'All open bills'], ['overdue', 'Overdue'], ...(vendorFilter ? [['vendor', 'This vendor']] : [])]}
          value={filter}
          onChange={setFilter}
        />
        <span className="muted">
          {count} selected · {money(total)}
        </span>
      </div>
      {!bills ? (
        <Loading />
      ) : visible.length === 0 ? (
        <Empty title="No unpaid bills" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    aria-label="Select all"
                    onChange={(e) => {
                      const next = { ...applied };
                      visible.forEach((b) => {
                        next[b.id] = e.target.checked ? b.balance : 0;
                      });
                      setApplied(next);
                    }}
                  />
                </th>
                <th>Payee</th>
                <th className="hide-sm">Ref no.</th>
                <th>Due date</th>
                <th className="num">Open balance</th>
                <th className="hide-sm" style={{ width: 120 }}>
                  Check / ref
                </th>
                <th className="num" style={{ width: 150 }}>
                  Payment
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr key={b.id}>
                  <td>
                    <input type="checkbox" checked={Number(applied[b.id]) > 0} onChange={(e) => setApplied({ ...applied, [b.id]: e.target.checked ? b.balance : 0 })} aria-label={`Pay ${b.vendor}`} />
                  </td>
                  <td>{b.vendor}</td>
                  <td className="hide-sm">{b.number}</td>
                  <td className={b.status === 'overdue' ? 'neg' : ''}>
                    {fmtDate(b.due_date)}
                    {b.status === 'overdue' && <small> · overdue</small>}
                  </td>
                  <td className="num">{money(b.balance)}</td>
                  <td className="hide-sm">
                    <input value={refs[b.id] || ''} onChange={(e) => setRefs({ ...refs, [b.id]: e.target.value })} disabled={!(Number(applied[b.id]) > 0)} />
                  </td>
                  <td>
                    <input className="num" type="number" step="0.01" min="0" max={b.balance} value={applied[b.id] || ''} onChange={(e) => setApplied({ ...applied, [b.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TxnScreen>
  );
}
