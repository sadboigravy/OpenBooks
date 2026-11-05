import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui.jsx';

export const REPORTS = [
  ['profit-loss', 'Profit and Loss', 'Income minus expenses over a period — are you making money?'],
  ['balance-sheet', 'Balance Sheet', 'What the business owns, owes and is worth on a date.'],
  ['ar-aging', 'Accounts Receivable Aging', 'Unpaid customer invoices grouped by how overdue they are.'],
  ['ap-aging', 'Accounts Payable Aging', 'Unpaid bills grouped by how overdue they are.'],
  ['sales-tax', 'Sales Tax Liability', 'Tax collected, tax paid on purchases and what you owe each tax agency.'],
  ['income-tax', 'Income Tax Summary', 'Income and deductions grouped by the lines of your business tax return.'],
  ['trial-balance', 'Trial Balance', 'Debit and credit totals for every account — for your accountant.'],
  ['general-ledger', 'General Ledger', 'Every transaction in every account, with running balances.'],
];

export default function Reports() {
  return (
    <>
      <PageHeader title="Reports" subtitle="Financial statements generated live from your ledger" />
      <div className="report-grid">
        {REPORTS.map(([key, title, desc]) => (
          <Link key={key} to={key === 'sales-tax' ? '/taxes?tab=report' : key === 'income-tax' ? '/taxes/income' : `/reports/${key}`} className="card report-card">
            <h2>{title}</h2>
            <p className="muted">{desc}</p>
            <span className="report-open">Open report →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
