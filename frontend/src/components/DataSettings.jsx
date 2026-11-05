import { useState } from 'react';
import { post, useApp } from '../lib.jsx';
import { ErrorBanner, Field, Modal } from './ui.jsx';

/** Shared action used by the dashboard banner and Settings. */
export function useRemoveSampleData() {
  const { notify, refreshSettings, refreshAccounts, refreshItems, refreshTax } = useApp();
  return async () => {
    if (!window.confirm('Remove all sample data? Sample customers, invoices, bills, employees and other records will be deleted.')) return false;
    try {
      await post('/settings/sample-data/remove');
      await Promise.all([refreshSettings(), refreshAccounts(), refreshItems(), refreshTax()]);
      notify('Sample data removed');
      return true;
    } catch (err) {
      notify(err.message, 'error');
      return false;
    }
  };
}

function EraseModal({ onClose }) {
  const { notify, refreshSettings, refreshAccounts, refreshItems, refreshTax } = useApp();
  const [confirm, setConfirm] = useState('');
  const [includeTax, setIncludeTax] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function erase(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/settings/erase', { confirm, include_tax_setup: includeTax });
      await Promise.all([refreshSettings(), refreshAccounts(), refreshItems(), refreshTax()]);
      notify('All data erased');
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Erase all data"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" form="erase-form" disabled={confirm !== 'ERASE' || busy}>
            {busy ? 'Erasing…' : 'Erase everything'}
          </button>
        </>
      }
    >
      <form id="erase-form" onSubmit={erase}>
        <ErrorBanner error={error} />
        <div className="alert alert-error">
          This permanently deletes every invoice, estimate, receipt, payment, bill, expense, bank transaction, journal entry, payroll run and timesheet, plus all customers,
          vendors, products and employees. It cannot be undone.
        </div>
        <p className="muted small">Kept: users and logins, company settings, the chart of accounts, payroll tax tables, and Stripe / AI settings.</p>
        <label className="checkbox" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={includeTax} onChange={(e) => setIncludeTax(e.target.checked)} /> Also delete sales tax agencies, rates and codes
        </label>
        <Field label="Type ERASE to confirm">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus autoComplete="off" />
        </Field>
      </form>
    </Modal>
  );
}

/** Settings → Data: remove sample data, or erase everything. */
export default function DataSettings() {
  const { settings } = useApp();
  const removeSample = useRemoveSampleData();
  const [erasing, setErasing] = useState(false);
  return (
    <div className="card form-card" id="data">
      <div className="card-header">
        <h2>Data</h2>
      </div>
      <div className="data-row">
        <div>
          <strong>Sample data</strong>
          <p className="muted small">
            {settings.sample_data_loaded
              ? 'Sample data is loaded. Removing it deletes only the records it created and leaves your settings and chart of accounts.'
              : 'No sample data is loaded.'}
          </p>
        </div>
        <button type="button" className="btn" disabled={!settings.sample_data_loaded} onClick={removeSample}>
          Remove sample data
        </button>
      </div>
      <div className="data-row">
        <div>
          <strong>Erase all data</strong>
          <p className="muted small">Start over with empty books. Deletes all transactions, customers, vendors, products and employees.</p>
        </div>
        <button type="button" className="btn btn-danger-ghost" onClick={() => setErasing(true)}>
          Erase all data…
        </button>
      </div>
      {erasing && <EraseModal onClose={() => setErasing(false)} />}
    </div>
  );
}
