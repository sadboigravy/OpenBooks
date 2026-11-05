// Shared helpers for the OpenBooks browser tests.
// Each suite calls start(), runs named steps, then finish(), which sets a non-zero exit code
// when a step fails or the browser saw errors (JS errors, console errors, failed API calls).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_LOGIN = { email: 'admin@openbooks.local', password: 'openbooks' };
const OWNER = { name: 'Test Owner', email: 'owner@example.com', password: 'correct horse battery' };

exports.DEFAULT_LOGIN = DEFAULT_LOGIN;
exports.OWNER = OWNER;
exports.args = () => ({ base: process.argv[2] || 'http://localhost:3999', out: process.argv[3] || path.join(__dirname, 'output') });

exports.start = async (base, out, opts = {}) => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 }, colorScheme: opts.theme || 'light' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.timeout || 8000);
  const st = { where: 'start', problems: [], fails: 0, allow: opts.allow || [] };
  page.on('pageerror', (e) => st.problems.push(`[${st.where}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && st.problems.push(`[${st.where}] console error: ${m.text()}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && !st.allow.some((a) => r.url().includes(a))) {
      st.problems.push(`[${st.where}] HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`);
    }
  });
  page.on('dialog', (d) => d.accept());

  const step = async (name, fn) => {
    st.where = name;
    try {
      await fn();
      console.log('ok  ', name);
    } catch (e) {
      st.fails++;
      console.log('FAIL', name, '-', e.message.split('\n').slice(0, 8).join(' / '));
      await page.screenshot({ path: path.join(out, `fail-${name.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {});
    }
  };
  // Calls the API with the browser's login cookie
  const api = async (p, method = 'GET', data) => {
    const r = await page.request.fetch(base + '/api' + p, { method, data, headers: data ? { 'Content-Type': 'application/json' } : {} });
    try {
      return await r.json();
    } catch {
      return r.status();
    }
  };
  const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 8000 });
  // A form field by its visible label (fields are <label class="field"><span class="field-label">…</span><input/></label>)
  const field = (label) =>
    page.locator(`label.field:has(> .field-label:text-is(${JSON.stringify(label)}))`).locator('input:not([type=checkbox]), select, textarea').first();
  const go = async (p) => {
    await page.goto(base + p);
    await page.waitForLoadState('networkidle').catch(() => {});
  };
  const login = async (email, password) => {
    await page.goto(base);
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await page.click('button:has-text("Sign in")');
  };
  const loginAs = async (user) => {
    await login(user.email, user.password);
    await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
  };
  // First run: sign in with the built-in login and create the real administrator
  const setup = async () => {
    await login(DEFAULT_LOGIN.email, DEFAULT_LOGIN.password);
    await page.waitForSelector('text=Create your administrator account');
    const inputs = page.locator('form input');
    await inputs.nth(0).fill(OWNER.name);
    await inputs.nth(1).fill(OWNER.email);
    await inputs.nth(2).fill(OWNER.password);
    await inputs.nth(3).fill(OWNER.password);
    await page.click('button:has-text("Create")');
    await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
  };
  const finish = async (title) => {
    const problems = [...new Set(st.problems)];
    console.log(`\n${title || 'Suite'}: ${st.fails} failed step(s), ${problems.length} browser problem(s)`);
    problems.forEach((p) => console.log('  ' + p));
    await browser.close();
    if (st.fails || problems.length) process.exitCode = 1;
  };
  return { browser, page, st, step, api, toast, field, go, login, loginAs, setup, finish };
};
