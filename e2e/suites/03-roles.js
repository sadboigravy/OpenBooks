// Suite 3 — run after 02-crawl (needs its admin and sample data).
// Creates an accountant and a read-only viewer, then opens the main pages as each of them and as
// the admin on a phone-sized screen. Fails on errors, error banners or sideways scrolling on phones.
// Viewers must be sent away from create/edit screens instead of hitting permission errors.
const { start, args, OWNER } = require('../lib.js');
const { base, out } = args();
const ACCOUNTANT = { email: 'acc@example.com', password: 'password1234' };
const VIEWER = { email: 'view@example.com', password: 'password1234' };
const ROUTES = ['/', '/sales', '/invoices', '/estimates', '/invoices/new', '/receive-payment', '/customers', '/items', '/expenses', '/bills', '/pay-bills',
  '/vendors', '/banking', '/reconcile', '/employees', '/time', '/payroll', '/payroll/run', '/journal/new', '/accounts', '/journal', '/taxes',
  '/taxes/payroll', '/taxes/income', '/reports', '/reports/profit-loss', '/settings', '/invoices/1', '/customers/1', '/employees/1', '/bills/1'];

(async () => {
  let failed = false;
  {
    const t = await start(base, out);
    await t.step('create accountant and viewer', async () => {
      await t.loginAs(OWNER);
      for (const [name, u, role] of [['Accountant', ACCOUNTANT, 'accountant'], ['Viewer', VIEWER, 'viewer']]) {
        const r = await t.api('/users', 'POST', { name, email: u.email, password: u.password, role });
        if (!r.id) throw new Error(`could not create ${role}: ${JSON.stringify(r)}`);
      }
    });
    await t.finish('Roles setup');
  }
  for (const [who, user, viewport] of [['admin on phone', OWNER, { width: 390, height: 844 }], ['accountant', ACCOUNTANT], ['viewer', VIEWER]]) {
    const t = await start(base, out, { viewport });
    await t.step(`${who}: sign in`, () => t.loginAs(user));
    for (const r of ROUTES) {
      await t.step(`${who}: ${r}`, async () => {
        await t.go(r);
        await t.page.waitForTimeout(250);
        const banners = await t.page.locator('.alert-error').allTextContents();
        if (banners.length) throw new Error('error banner: ' + banners.join(' | '));
        if (viewport) {
          const width = await t.page.evaluate(() => document.documentElement.scrollWidth);
          if (width > viewport.width + 1) throw new Error(`page scrolls sideways (${width}px wide)`);
        }
      });
    }
    await t.finish(`Roles: ${who}`);
  }
})();
