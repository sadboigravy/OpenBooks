// Suite 5 — runs against fake_provider_server.py (not the Docker container), started with
// ADMIN_PASSWORD=password123 so there is no first-run setup.
// Saves GoCardless keys in Settings, connects a bank through SimpleFIN, links an account,
// syncs, and checks the transactions arrive in For review; then opens the GoCardless bank picker.
const { start, args } = require('../lib.js');
const { base, out } = args();
const ADMIN = { email: 'admin@openbooks.local', password: 'password123' };

(async () => {
  const t = await start(base, out);
  const { page, step, go } = t;
  await step('sign in', () => t.loginAs(ADMIN));
  await step('save provider keys in settings', async () => {
    await go('/settings#bank-connections');
    const card = page.locator('#bank-connections');
    await card.getByLabel('Secret ID').fill('test-id');
    await card.getByLabel('Secret key').fill('test-key');
    await card.getByRole('button', { name: 'Save bank connections' }).click();
    await t.toast('Bank connection settings saved');
    await card.locator('text=Saved').first().waitFor();
    if ((await card.innerText()).includes('test-key')) throw new Error('secret shown back in the page');
  });
  await step('connect a bank with SimpleFIN', async () => {
    await go('/banking');
    await page.click('button:has-text("Connect bank")');
    await page.click('.provider-option:has-text("SimpleFIN")');
    await page.fill('textarea', Buffer.from('https://bridge.example/simplefin/claim/abc').toString('base64'));
    await page.click('#connect-form button:has-text("Connect")');
    await page.waitForSelector('.bank-connection:has-text("First Community Bank")');
  });
  await step('link an account and sync', async () => {
    const row = page.locator('.bank-connection tbody tr').filter({ has: page.locator('td:first-child', { hasText: 'Business Checking' }) });
    await row.locator('select').selectOption({ label: '1010 · Business Checking' });
    await row.locator('button:has-text("Save")').click();
    await t.toast('Account linked');
    await page.click('.bank-connection button:has-text("Sync now")');
    await t.toast('Imported 2 new transactions');
    await page.waitForSelector('text=Coffee Co – POS 123');
    await page.waitForSelector('text=Client payment ACME');
  });
  await step('sync again imports nothing new', async () => {
    await page.click('.bank-connection button:has-text("Sync now")');
    await t.toast('is up to date');
  });
  await step('GoCardless bank picker', async () => {
    await page.click('button:has-text("Connect bank")');
    await page.click('.provider-option:has-text("GoCardless")');
    await page.waitForSelector('.bank-picker-item:has-text("Monzo")');
    await page.keyboard.press('Escape');
  });
  await t.finish('Bank feeds');
})();
