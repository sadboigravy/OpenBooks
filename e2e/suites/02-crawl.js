// Suite 2 — needs a brand-new database.
// Sets up the admin, loads sample data, then opens every page and detail view (and every tab on it),
// failing on JavaScript errors, failed API calls, error banners and blank pages.
// Set SCREENSHOTS=1 to save a full-page screenshot of every page into the output folder.
const { start, args } = require('../lib.js');
const { base, out } = args();
const theme = process.env.THEME || 'light';

(async () => {
  const t = await start(base, out, { theme });
  const { page, step, api, go } = t;
  await step('first-run setup', t.setup);
  await step('load sample data', async () => {
    await page.click('button:has-text("Load sample data")');
    await page.waitForSelector("text=You're looking at sample data", { timeout: 30000 });
  });

  const routes = ['/', '/sales', '/invoices', '/estimates', '/invoices/new', '/estimates/new', '/sales-receipts/new', '/receive-payment', '/customers', '/items',
    '/expenses', '/expenses/new', '/checks/new', '/bills', '/bills/new', '/pay-bills', '/vendors', '/banking', '/deposits/new', '/transfers/new', '/reconcile',
    '/employees', '/time', '/payroll', '/payroll/run', '/accounts', '/journal', '/journal/new', '/taxes', '/taxes?tab=report', '/taxes/payroll', '/taxes/income',
    '/reports', '/settings', '/users'];
  await go('/reports');
  for (const href of await page.locator('a.report-card').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) routes.push(href);

  // detail and edit views, using real ids from the sample data
  const first3 = (list, f) => (Array.isArray(list) ? list : []).slice(0, 3).forEach((x) => routes.push(f(x)));
  const docs = await api('/invoices?kind=all');
  first3(docs.filter((d) => d.kind === 'invoice'), (d) => `/invoices/${d.id}`);
  first3(docs.filter((d) => d.kind === 'invoice'), (d) => `/invoices/${d.id}/edit`);
  first3(docs.filter((d) => d.kind === 'estimate'), (d) => `/estimates/${d.id}`);
  first3(docs.filter((d) => d.kind === 'sales_receipt'), (d) => `/sales-receipts/${d.id}`);
  const bills = await api('/bills');
  first3(bills, (b) => `/bills/${b.id}`);
  first3(bills, (b) => `/bills/${b.id}/edit`);
  first3(await api('/customers'), (c) => `/customers/${c.id}`);
  first3(await api('/vendors'), (c) => `/vendors/${c.id}`);
  first3(await api('/employees'), (e) => `/employees/${e.id}`);
  first3(await api('/payroll/runs'), (r) => `/payroll/runs/${r.id}`);
  for (const e of (await api('/journal-entries')).slice(0, 60)) {
    if (e.source_type === 'manual') routes.push(`/journal/${e.id}`);
    if (e.source_type === 'deposit') routes.push(`/deposits/${e.id}`);
    if (e.source_type === 'transfer') routes.push(`/transfers/${e.id}`);
    if (e.source_type === 'expense') routes.push(`/expenses/${e.source_id}/edit`);
  }
  first3(await api('/bank/accounts'), (a) => `/reconcile/${a.id}`); // opened directly, without a statement date

  const unique = [...new Set(routes)];
  for (const r of unique) {
    await step(`page ${r}`, async () => {
      await go(r);
      await page.waitForTimeout(250);
      const banners = await page.locator('.alert-error').allTextContents();
      if (banners.length) throw new Error('error banner: ' + banners.join(' | '));
      const text = await page.evaluate(() => (document.querySelector('main')?.innerText || document.body.innerText).trim().length);
      if (text < 20) throw new Error('page looks blank');
      const tabs = page.locator('.tabs button, [role=tab]');
      for (let i = 0; i < (await tabs.count()); i++) {
        await tabs.nth(i).click();
        await page.waitForTimeout(150);
      }
      if (process.env.SCREENSHOTS) await page.screenshot({ path: `${out}/${theme}${r.replace(/\W+/g, '_') || '_home'}.png`, fullPage: true });
    });
  }
  console.log(`visited ${unique.length} pages`);
  await t.finish(`Crawl (${theme})`);
})();
