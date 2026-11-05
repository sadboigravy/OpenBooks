import { money, round2, useApp } from '../lib.jsx';
import { AccountSelect, TaxCodeSelect, isCategoryAccount } from './ui.jsx';

export const blankCategoryLine = (taxCodeId = '') => ({ account_id: '', description: '', amount: '', tax_code_id: taxCodeId });
export const linesTotal = (lines) => round2(lines.reduce((s, l) => s + Number(l.amount || 0), 0));

/** True when any tax code has a rate that applies to purchases (VAT/GST-style input tax). */
export function usePurchaseTaxEnabled() {
  const { taxSetup } = useApp();
  return (taxSetup?.codes || []).some((c) => c.active && c.rates.some((r) => r.applies_to !== 'sales'));
}

/** Payload for /tax/preview from category lines. */
export const purchasePreviewPayload = (lines, inclusive) => ({
  direction: 'purchases',
  amounts_inclusive: inclusive,
  lines: lines.filter((l) => Number(l.amount)).map((l) => ({ amount: l.amount, tax_code_id: l.tax_code_id || null })),
});

/** Editable "category / description / (tax) / amount" rows used by bills and expenses. */
export default function CategoryLines({ lines, onChange, preview, inclusive }) {
  const showTax = usePurchaseTaxEnabled() || lines.some((l) => l.tax_code_id);
  const setLine = (idx, k, v) => onChange(lines.map((l, i) => (i === idx ? { ...l, [k]: v } : l)));
  const entered = linesTotal(lines);
  return (
    <div className="lines">
      <table className="table lines-table">
        <thead>
          <tr>
            <th style={{ width: showTax ? '32%' : '38%' }}>Category</th>
            <th>Description</th>
            {showTax && <th style={{ width: '18%' }}>Tax</th>}
            <th className="num" style={{ width: '16%' }}>
              Amount
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => (
            <tr key={idx}>
              <td data-label="Category">
                <AccountSelect value={l.account_id} onChange={(v) => setLine(idx, 'account_id', v)} filter={isCategoryAccount} placeholder="Choose a category…" required />
              </td>
              <td data-label="Description">
                <input value={l.description} onChange={(e) => setLine(idx, 'description', e.target.value)} />
              </td>
              {showTax && (
                <td data-label="Tax">
                  <TaxCodeSelect value={l.tax_code_id} onChange={(v) => setLine(idx, 'tax_code_id', v)} direction="purchases" placeholder="No tax" />
                </td>
              )}
              <td data-label="Amount">
                <input className="num" type="number" step="0.01" value={l.amount} onChange={(e) => setLine(idx, 'amount', e.target.value)} placeholder="0.00" required />
              </td>
              <td>
                <button type="button" className="icon-btn" aria-label="Remove line" disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, i) => i !== idx))}>
                  🗑
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={showTax ? 3 : 2}>
              <button type="button" className="btn btn-sm" onClick={() => onChange([...lines, blankCategoryLine(lines[lines.length - 1]?.tax_code_id || '')])}>
                Add lines
              </button>
            </td>
            <td className="num">
              {preview && preview.tax ? (
                <div className="line-totals">
                  <div className="muted small">
                    Subtotal {money(preview.subtotal)}
                    {inclusive ? ' (excl. tax)' : ''}
                  </div>
                  {preview.details.map((d, i) => (
                    <div key={i} className="muted small">
                      {d.name} {money(d.tax)}
                    </div>
                  ))}
                  <strong>{money(preview.total)}</strong>
                </div>
              ) : (
                <strong>{money(entered)}</strong>
              )}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
