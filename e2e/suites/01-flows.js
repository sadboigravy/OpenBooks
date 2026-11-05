// Suite 1 — needs a brand-new database.
// First-run admin setup, then every create/edit task through the UI: customers, vendors, products,
// invoices, estimates, receipts, payments, expenses, bills, deposits, transfers, journal entries,
// bank transactions, CSV import, reconcile, employees, timesheets, payroll, users, settings, erase.
const { start, args, OWNER } = require('../lib.js');
const { base, out } = args();
(async () => {
  const t = await start(base, out);
  const { page, step, api, toast, field: L, go } = t;
  const saveClose = async () => { await page.click('button[data-mode=close]'); };

  await step('login hint shown on first run', async () => { await page.goto(base); await page.waitForSelector('text=First time?'); });
  await step('first-run setup', t.setup);
  await step('login hint gone after setup', async () => {
    await page.context().clearCookies(); await page.goto(base); await page.waitForSelector('button:has-text("Sign in")'); await page.waitForTimeout(800);
    if (await page.locator('text=First time?').count()) throw new Error('hint still shown');
    await t.loginAs(OWNER);
  });

  await step('new customer', async () => {
    await go('/customers'); await page.click('button:has-text("New customer")');
    await L('Name *').fill('Acme Corp'); await L('Email').fill('ap@acme.test');
    await page.click('.modal button.btn-primary'); await page.waitForSelector('text=Acme Corp');
  });
  await step('new vendor', async () => {
    await go('/vendors'); await page.click('button:has-text("New vendor")');
    await L('Name *').fill('Office Depot'); await page.click('.modal button.btn-primary'); await page.waitForSelector('text=Office Depot');
  });
  await step('new product', async () => {
    await go('/items'); await page.click('main .btn-primary:has-text("New")');
    await L('Name *').fill('Consulting hour'); await L('Sales price / rate').fill('150');
    const inc = L('Income account *'); if (!(await inc.inputValue())) await inc.selectOption({ index: 1 });
    await page.click('.modal button.btn-primary'); await page.waitForSelector('td:has-text("Consulting hour")');
  });
  let invId;
  await step('new invoice', async () => {
    await go('/invoices/new');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Acme Corp' }) }).first().selectOption({ label: 'Acme Corp' });
    const row = page.locator('.lines-table tbody tr').first();
    await row.getByLabel('Product or service').selectOption({ label: 'Consulting hour' }).catch(async () => { await row.locator('input').first().fill('Consulting hour'); });
    await row.locator('td[data-label=Qty] input').fill('4');
    await page.waitForTimeout(400);
    await saveClose();
    await page.waitForURL(/\/invoices(\/\d+)?$/, { timeout: 10000 });
    const inv = (await api('/invoices?kind=invoice')).find((i) => i.customer === 'Acme Corp');
    if (!inv) throw new Error('invoice not created'); invId = inv.id;
    if (Math.abs(inv.total - 600) > 0.01) throw new Error('total ' + inv.total);
  });
  await step('view + edit invoice', async () => {
    await go(`/invoices/${invId}`); await page.waitForSelector('text=Acme Corp');
    await go(`/invoices/${invId}/edit`); await page.waitForSelector('.lines-table td[data-label=Qty] input'); await page.locator('.lines-table tbody tr').first().locator('td[data-label=Qty] input').fill('5'); await saveClose();
    await page.waitForTimeout(1200);
    const inv = await api(`/invoices/${invId}`); if (Math.abs(inv.total - 750) > 0.01) throw new Error('edited total ' + inv.total);
  });
  await step('receive payment', async () => {
    await go(`/receive-payment`);
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Acme Corp' }) }).first().selectOption({ label: 'Acme Corp' });
    await page.waitForTimeout(600);
    const dep = L('Deposit to *'); if (!(await dep.inputValue())) await dep.selectOption({ index: 1 });
    await L('Amount received').fill('750'); await page.waitForTimeout(300);
    await saveClose(); await page.waitForTimeout(1500);
    const inv = await api(`/invoices/${invId}`); if (inv.balance !== 0) throw new Error('balance ' + inv.balance + ' status ' + inv.status);
  });
  await step('estimate -> invoice', async () => {
    await go('/estimates/new');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Acme Corp' }) }).first().selectOption({ label: 'Acme Corp' });
    const row = page.locator('.lines-table tbody tr').first();
    await row.getByLabel('Product or service').selectOption({ label: 'Consulting hour' }); await row.locator('td[data-label=Qty] input').fill('2');
    await saveClose(); await page.waitForTimeout(1200);
    const est = (await api('/invoices?kind=estimate')).find((i) => i.customer === 'Acme Corp');
    await go(`/estimates/${est.id}`); await page.click('a:has-text("Create invoice")');
    await page.waitForSelector('text=Creating an invoice from estimate'); await saveClose(); await page.waitForTimeout(1500);
    const e2 = await api(`/invoices/${est.id}`); if (e2.status !== 'closed' && e2.status !== 'converted') throw new Error('estimate status ' + e2.status);
  });
  await step('sales receipt', async () => {
    await go('/sales-receipts/new');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Acme Corp' }) }).first().selectOption({ label: 'Acme Corp' });
    const row = page.locator('.lines-table tbody tr').first();
    await row.getByLabel('Product or service').selectOption({ label: 'Consulting hour' });
    const dep = L('Deposit to *'); if (!(await dep.inputValue())) await dep.selectOption({ index: 1 });
    await saveClose(); await page.waitForTimeout(1500);
    if (!(await api('/invoices?kind=sales_receipt')).length) throw new Error('no receipt');
  });
  await step('expense', async () => {
    await go('/expenses/new');
    await L('Payee').selectOption({ label: 'Office Depot' }).catch(() => {});
    const pay = page.getByLabel(/Payment account|Pay from/).first(); if (await pay.count() && !(await pay.inputValue())) await pay.selectOption({ index: 1 });
    const cat = page.locator('.lines-table tbody tr').first();
    await cat.locator('select').first().selectOption({ label: /Office/ }).catch(async () => cat.locator('select').first().selectOption({ index: 5 }));
    await cat.locator('input[type=number]').last().fill('89.99');
    await saveClose(); await page.waitForTimeout(1500);
    const ex = await api('/expenses'); if (!JSON.stringify(ex).includes('89.99')) throw new Error('expense missing');
  });
  let billId;
  await step('bill', async () => {
    await go('/bills/new');
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Office Depot' }) }).first().selectOption({ label: 'Office Depot' });
    const cat = page.locator('.lines-table tbody tr').first();
    await cat.locator('select').first().selectOption({ index: 5 });
    await cat.locator('input[type=number]').last().fill('240');
    await saveClose(); await page.waitForTimeout(1500);
    const b = (await api('/bills')).find((x) => x.vendor === 'Office Depot'); if (!b) throw new Error('bill missing'); billId = b.id;
  });
  await step('pay bills', async () => {
    await go('/pay-bills'); await page.waitForSelector('text=Office Depot');
    const acct = L('Payment account *'); if (!(await acct.inputValue())) await acct.selectOption({ index: 1 });
    await page.locator('tr', { hasText: 'Office Depot' }).locator('input[type=checkbox]').check();
    await saveClose(); await page.waitForTimeout(1500);
    const b = await api(`/bills/${billId}`); if (b.balance !== 0) throw new Error('bill balance ' + b.balance);
  });
  await step('deposit', async () => {
    await go('/deposits/new');
    const a = L('Account *'); if (!(await a.inputValue())) await a.selectOption({ index: 1 });
    const row = page.locator('.lines-table tbody tr').first();
    await row.locator('select').first().selectOption({ index: 3 }); await row.locator('input[type=number]').last().fill('100');
    await saveClose(); await page.waitForTimeout(1500);
  });
  await step('transfer', async () => {
    await go('/transfers/new');
    await L('Transfer funds from *').selectOption({ index: 1 }); await L('Transfer funds to *').selectOption({ index: 2 });
    await L('Transfer amount *').fill('50'); await saveClose(); await page.waitForTimeout(1500);
  });
  await step('journal entry', async () => {
    await go('/journal/new');
    const rows = page.locator('.lines-table tbody tr');
    await rows.nth(0).locator('select').first().selectOption({ index: 1 }); await rows.nth(0).locator('td[data-label=Debit] input').fill('25');
    await rows.nth(1).locator('select').first().selectOption({ index: 6 }); await rows.nth(1).locator('td[data-label=Credit] input').fill('25');
    await saveClose(); await page.waitForTimeout(1500);
    if (!(await api('/journal-entries')).some((e) => e.source_type === 'manual')) throw new Error('no manual JE');
  });
  await step('bank: add + categorize', async () => {
    await go('/banking'); await page.click('button:has-text("+ Add transaction")');
    await page.locator('.modal input[type=date]').fill('2026-11-01').catch(() => {});
    await L('Description *').fill('Coffee');
    await L('Amount *').fill('4.5');
    await page.click('.modal button.btn-primary'); await page.waitForSelector('td:has-text("Coffee")');
    const row = page.locator('tr', { hasText: 'Coffee' });
    await row.locator('select').selectOption({ index: 5 }); await row.locator('button:has-text("Add")').click();
    await toast('');
  });
  await step('bank: CSV import', async () => {
    await page.click('button:has-text("Import CSV")');
    await page.setInputFiles('.modal input[type=file]', { name: 's.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Description,Amount\n2026-10-30,Client deposit,500.00\n2026-10-31,Gas station,-40.12\n') });
    await page.click('.modal button:has-text("Import")'); await page.waitForSelector('td:has-text("Gas station")');
  });
  await step('reconcile', async () => {
    await go('/reconcile');
    const a = L('Account *'); await a.selectOption({ index: 1 });
    await L('Ending balance *').fill('0'); await page.click('button:has-text("Start reconciling")');
    await page.waitForURL(/reconcile\/\d+/); await page.waitForSelector('text=Difference');
  });
  await step('reconcile direct url', async () => { await go('/reconcile/1'); await page.waitForSelector('text=Difference'); });
  await step('employee', async () => {
    await go('/employees'); await page.click('main .btn-primary');
    await L('Full name *').fill('Jamie Worker');
    const rate = page.getByLabel(/Hourly rate|Pay rate|Rate/).first(); await rate.fill('25');
    await page.click('.modal button.btn-primary'); await page.waitForSelector('text=Jamie Worker');
  });
  await step('timesheet', async () => {
    await go('/time'); await page.waitForTimeout(500);
    const empSel = page.locator('select').first(); await empSel.selectOption({ label: 'Jamie Worker' }).catch(() => {});
    const hrs = page.locator('input[type=number]'); await hrs.nth(0).fill('8'); await hrs.nth(1).fill('8');
    await page.click('button:has-text("Save timesheet")'); await toast('');
  });
  await step('run payroll', async () => {
    await go('/payroll/run'); await page.waitForTimeout(800);
    const b = L('Bank account *'); if (!(await b.inputValue())) await b.selectOption({ index: 1 });
    await page.waitForSelector('text=Jamie Worker');
    await page.locator('tr', { hasText: 'Jamie Worker' }).locator('input[type=number]').fill('10');
    await page.waitForSelector('text=Total payroll cost');
    await page.click('button:has-text("Submit payroll")'); await page.waitForURL(/payroll\/runs\/\d+/, { timeout: 10000 });
  });
  await step('user add', async () => {
    await go('/users'); await page.click('button:has-text("Add user")');
    await L('Name *').fill('Ann Accountant'); await L('Email *').fill('ann@example.com');
    await page.locator('.modal input[type=password]').first().fill('password1234');
    await L('Role').selectOption('accountant'); await page.click('.modal button.btn-primary'); await page.waitForSelector('text=ann@example.com');
  });
  await step('settings save', async () => {
    await go('/settings'); await L('Company name *').fill('Tester LLC'); await page.click('button:has-text("Save settings")'); await toast('Settings saved');
  });
  await step('tax method switch', async () => {
    await go('/settings#tax-method'); await page.waitForTimeout(600);
    const card = page.locator('#tax-method');
    await card.locator('text=US tax tables (unverified)').first().click();
    await page.click('button:has-text("Save tax calculation")'); await page.waitForTimeout(1200);
    const m = await api('/tax/method'); if (m.method !== 'us_tables') throw new Error('method ' + m.method);
  });
  await step('search', async () => { await page.fill('input[aria-label=Search], input[placeholder^="Search"]', 'Acme'); await page.waitForSelector('text=Acme Corp'); });
  await step('theme toggle', async () => { await go('/'); await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); });
  await step('books balance', async () => {
    const bs = await api('/reports/balance-sheet'); if (!bs.balanced) throw new Error('balance sheet not balanced');
    const tb = await api('/reports/trial-balance'); if (Math.abs((tb.total_debit ?? tb.totals?.debit) - (tb.total_credit ?? tb.totals?.credit)) > 0.001) throw new Error('trial balance');
  });
  await step('sample data refused once real data exists', async () => {
    t.st.allow.push('/settings/sample-data'); // a 400 is the expected answer here
    const r = await api('/settings/sample-data', 'POST', {});
    if (!r.error) throw new Error('sample data loaded into books that already had data');
  });
  await step('erase all', async () => {
    await go('/settings#data'); await page.click('button:has-text("Erase all data…")');
    await page.locator('.modal input').last().fill('ERASE'); await page.click('.modal button:has-text("Erase everything")'); await toast('All data erased');
    if ((await api('/invoices?kind=all')).length) throw new Error('invoices remain');
  });
  await t.finish('Flows');
})();
