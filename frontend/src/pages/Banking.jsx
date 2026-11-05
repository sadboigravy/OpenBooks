import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SOURCE_LABELS, del, fmtDate, money, post, sourceLink, today, useApi, useApp } from '../lib.jsx';
import { BankConnections, ConnectBankModal } from '../components/BankFeeds.jsx';
import { AccountSelect, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, StatusBadge, Tabs } from '../components/ui.jsx';

function ImportModal({ account, onClose, onDone }) {
  const { notify } = useApp();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [flip, setFlip] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function readFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/bank/import', { account_id: account.id, csv, flip_sign: flip });
      notify(`Imported ${r.imported} transaction${r.imported === 1 ? '' : 's'}${r.skipped_duplicates ? ` (${r.skipped_duplicates} duplicates skipped)` : ''}`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const preview = csv.split(/\r?\n/).filter(Boolean).slice(0, 6);

  return (
    <Modal
      wide
      title={`Import statement into ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="import-form" disabled={busy || !csv}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <form id="import-form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <p className="muted">
          Download a CSV statement from your bank. It needs a header row with a <strong>Date</strong> column, a <strong>Description</strong> column and either an{' '}
          <strong>Amount</strong> column (negative = money out) or separate <strong>Debit</strong>/<strong>Credit</strong> columns. Duplicates are skipped automatically.
        </p>
        <label className="file-drop">
          <input type="file" accept=".csv,text/csv" onChange={readFile} />
          <span>{fileName || 'Choose a CSV file…'}</span>
        </label>
        {preview.length > 0 && (
          <pre className="csv-preview">
            {preview.join('\n')}
            {csv.split(/\r?\n/).filter(Boolean).length > 6 ? '\n…' : ''}
          </pre>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip signs (use if purchases show as positive numbers, common for credit card
          exports)
        </label>
      </form>
    </Modal>
  );
}

function AddTransactionModal({ account, onClose, onDone }) {
  const { notify } = useApp();
  const [form, setForm] = useState({ date: today(), description: '', direction: 'out', amount: '' });
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      const amount = Math.abs(Number(form.amount)) * (form.direction === 'out' ? -1 : 1);
      await post('/bank/transactions', { account_id: account.id, date: form.date, description: form.description, amount });
      notify('Transaction added for review');
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      title={`Add transaction – ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="addtx-form">
            Add
          </button>
        </>
      }
    >
      <form id="addtx-form" className="form-grid" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Date *">
          <input type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field label="Type">
          <select value={form.direction} onChange={set('direction')}>
            <option value="out">Money out (spent)</option>
            <option value="in">Money in (received)</option>
          </select>
        </Field>
        <Field label="Description *" className="span-2">
          <input value={form.description} onChange={set('description')} required />
        </Field>
        <Field label="Amount *">
          <input type="number" step="0.01" min="0.01" value={form.amount} onChange={set('amount')} required />
        </Field>
      </form>
    </Modal>
  );
}

function ReviewRow({ tx, account, onChanged, canEdit }) {
  const { notify } = useApp();
  const [category, setCategory] = useState(tx.category_account_id || '');
  const [error, setError] = useState(null);
  async function act(path, body, message) {
    setError(null);
    try {
      await post(path, body);
      notify(message);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  const filter = (a) => a.id !== account.id && !['accounts_receivable', 'accounts_payable'].includes(a.subtype);
  return (
    <tr>
      <td>{fmtDate(tx.date)}</td>
      <td>
        {tx.description}
        {error && <div className="small neg">{error}</div>}
      </td>
      <td className="num neg">{tx.amount < 0 ? money(-tx.amount) : ''}</td>
      <td className="num pos">{tx.amount > 0 ? money(tx.amount) : ''}</td>
      <td style={{ minWidth: 220 }}>
        {canEdit ? (
          <AccountSelect value={category} onChange={setCategory} filter={filter} placeholder="Choose a category…" />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="row-actions">
        {canEdit && (
          <>
            <button className="btn btn-sm btn-primary" disabled={!category} onClick={() => act(`/bank/transactions/${tx.id}/categorize`, { account_id: category }, 'Transaction added to books')}>
              Add
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Already recorded elsewhere (e.g. an invoice payment) or not a business transaction"
              onClick={() => act(`/bank/transactions/${tx.id}/exclude`, {}, 'Transaction excluded')}
            >
              Exclude
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

export default function Banking() {
  const { canEdit, notify, user } = useApp();
  const isAdmin = user.role === 'admin';
  const accountsReq = useApi('/bank/accounts');
  const connReq = useApi('/bank-feeds/connections');
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('review');
  const [modal, setModal] = useState(params.get('connect') && isAdmin ? 'connect' : null);
  const [showConnections, setShowConnections] = useState(!!params.get('connections'));
  const [syncing, setSyncing] = useState(false);
  const connections = connReq.data || [];
  const needsMapping = connections.some((c) => c.accounts.length && c.accounts.every((a) => !a.account_id));

  useEffect(() => {
    if (params.get('connect') || params.get('connections')) setParams({}, { replace: true });
  }, []);
  useEffect(() => {
    if (needsMapping) setShowConnections(true);
  }, [needsMapping]);

  async function syncAll() {
    setSyncing(true);
    try {
      const r = await post('/bank-feeds/sync');
      if (r.errors.length) notify(r.errors.join(' · '), 'error');
      else notify(r.imported ? `Imported ${r.imported} new transaction${r.imported === 1 ? '' : 's'}` : 'Your banks are up to date');
      setTab('review');
      refresh();
      connReq.reload();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (accountsReq.data && !selected) {
      const withReview = accountsReq.data.find((a) => a.to_review > 0);
      const firstBank = accountsReq.data.find((a) => a.subtype === 'bank');
      setSelected((withReview || firstBank || accountsReq.data[0])?.id ?? null);
    }
  }, [accountsReq.data, selected]);

  const account = accountsReq.data?.find((a) => a.id === selected);
  const txPath = account && tab !== 'register' ? `/bank/transactions?account_id=${account.id}&status=${tab === 'all' ? '' : tab}` : null;
  const txs = useApi(txPath);
  const register = useApi(account && tab === 'register' ? `/bank/register/${account.id}` : null);

  const refresh = () => {
    accountsReq.reload();
    txs.reload();
  };

  async function act(fn, message) {
    try {
      await fn();
      notify(message);
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  if (accountsReq.loading && !accountsReq.data) return <Loading />;
  if (accountsReq.error) return <ErrorBanner error={accountsReq.error} />;

  return (
    <>
      <PageHeader title="Banking" subtitle="Review bank and credit card activity and add it to your books">
        {canEdit && connections.length > 0 && (
          <button className="btn" onClick={syncAll} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync banks'}
          </button>
        )}
        {isAdmin && (
          <button className="btn" onClick={() => setModal('connect')}>
            Connect bank
          </button>
        )}
        {canEdit && account && (
          <>
            <Link className="btn" to="/reconcile">
              Reconcile
            </Link>
            <Link className="btn" to="/deposits/new">
              Deposit
            </Link>
            <Link className="btn" to="/transfers/new">
              Transfer
            </Link>
            <button className="btn" onClick={() => setModal('add')}>
              + Add transaction
            </button>
            <button className="btn btn-primary" onClick={() => setModal('import')}>
              Import CSV
            </button>
          </>
        )}
      </PageHeader>

      {connections.length > 0 && (
        <div className="card feed-strip">
          <div>
            <strong>
              {connections.length} connected bank{connections.length === 1 ? '' : 's'}
            </strong>
            <span className="muted small">
              {' '}
              · {connections.map((c) => c.institution).join(', ')}
              {connections.some((c) => c.status === 'error') && <span className="neg"> · a connection needs attention</span>}
              {needsMapping && <span className="neg"> · choose where accounts import</span>}
            </span>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowConnections(!showConnections)}>
            {showConnections ? 'Hide' : 'Manage'}
          </button>
        </div>
      )}
      {showConnections && connections.length > 0 && (
        <BankConnections
          connections={connections}
          reload={() => {
            connReq.reload();
            accountsReq.reload();
          }}
          onSynced={() => {
            setTab('review');
            refresh();
          }}
        />
      )}

      {accountsReq.data.length === 0 ? (
        <div className="card">
          <Empty title="No bank accounts">
            Add an account with detail type <em>bank</em>, <em>cash</em> or <em>credit card</em> in the <Link to="/accounts">Chart of Accounts</Link>.
          </Empty>
        </div>
      ) : (
        <div className="bank-cards">
          {accountsReq.data.map((a) => (
            <button key={a.id} type="button" className={`card bank-card ${a.id === selected ? 'selected' : ''}`} onClick={() => setSelected(a.id)}>
              <div className="bank-card-name">{a.name}</div>
              <div className="muted small">{a.subtype === 'credit_card' ? 'Credit card · owed' : 'Balance in books'}</div>
              <div className="bank-card-balance">{money(a.balance)}</div>
              {a.to_review > 0 ? <span className="badge badge-amber">{a.to_review} to review</span> : <span className="badge badge-green">Up to date</span>}
            </button>
          ))}
        </div>
      )}

      {account && (
        <>
          <div className="toolbar">
            <Tabs
              tabs={[
                ['review', `For review${account.to_review ? ` (${account.to_review})` : ''}`],
                ['categorized', 'Categorized'],
                ['excluded', 'Excluded'],
                ['register', 'Account register'],
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>

          {tab === 'register' ? (
            register.loading && !register.data ? (
              <Loading />
            ) : register.data?.length ? (
              <div className="card table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="hide-sm">Type</th>
                      <th className="num">Amount</th>
                      <th className="num">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.data.map((r, i) => {
                      const link = sourceLink(r.source_type, r.source_id, r.entry_id);
                      return (
                        <tr key={i}>
                          <td>{fmtDate(r.date)}</td>
                          <td>{link ? <Link to={link}>{r.memo}</Link> : r.memo}</td>
                          <td className="hide-sm">{SOURCE_LABELS[r.source_type]}</td>
                          <td className={`num ${r.amount < 0 ? 'neg' : ''}`}>{money(r.amount)}</td>
                          <td className="num">{money(r.balance)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <Empty title="Nothing recorded in this account yet" />
              </div>
            )
          ) : txs.loading && !txs.data ? (
            <Loading />
          ) : !txs.data?.length ? (
            <div className="card">
              <Empty title={tab === 'review' ? 'Nothing to review' : 'No transactions'}>
                {tab === 'review' && canEdit && (connections.length ? 'New transactions from your connected banks appear here after each sync.' : 'Connect your bank, import a CSV statement, or add a transaction manually.')}
              </Empty>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Spent</th>
                    <th className="num">Received</th>
                    <th>{tab === 'review' ? 'Category' : tab === 'categorized' ? 'Category' : 'Status'}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {txs.data.map((tx) =>
                    tab === 'review' ? (
                      <ReviewRow key={tx.id} tx={tx} account={account} onChanged={refresh} canEdit={canEdit} />
                    ) : (
                      <tr key={tx.id}>
                        <td>{fmtDate(tx.date)}</td>
                        <td>{tx.description}</td>
                        <td className="num neg">{tx.amount < 0 ? money(-tx.amount) : ''}</td>
                        <td className="num pos">{tx.amount > 0 ? money(tx.amount) : ''}</td>
                        <td>{tx.status === 'categorized' ? tx.category : <StatusBadge status={tx.status} />}</td>
                        <td className="row-actions">
                          {canEdit && (
                            <button className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/bank/transactions/${tx.id}/undo`), 'Moved back to review')}>
                              Undo
                            </button>
                          )}
                          {canEdit && tx.status === 'excluded' && (
                            <button className="btn btn-sm btn-danger-ghost" onClick={() => window.confirm('Delete this bank line?') && act(() => del(`/bank/transactions/${tx.id}`), 'Deleted')}>
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {modal === 'import' && (
        <ImportModal
          account={account}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setTab('review');
            refresh();
          }}
        />
      )}
      {modal === 'connect' && (
        <ConnectBankModal
          onClose={() => setModal(null)}
          onConnected={(c) => {
            setModal(null);
            notify(`${c.institution} connected. Choose which OpenBooks account each bank account imports into.`);
            setShowConnections(true);
            connReq.reload();
          }}
        />
      )}
      {modal === 'add' && (
        <AddTransactionModal
          account={account}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setTab('review');
            refresh();
          }}
        />
      )}
    </>
  );
}
