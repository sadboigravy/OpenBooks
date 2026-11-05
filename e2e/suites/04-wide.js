// Suite 4 — run after 02-crawl (needs its admin and sample data).
// Checks the layout on wide and ultrawide screens: no sideways scrolling, content centred beside the
// sidebar, the interface zoomed by the expected amount, the dashboard chart inside its card, and the
// settings menu and pop-up windows fitting on screen. Saves a screenshot per size for a visual check.
const { start, args, OWNER } = require('../lib.js');
const { base, out } = args();
const SIZES = [
  [1366, 768, 1],
  [1920, 1080, 1],
  [2560, 1440, 1.15],
  [3440, 1440, 1.5],
  [5120, 1440, 1.8],
];

(async () => {
  for (const [w, h, expectedZoom] of SIZES) {
    const t = await start(base, out, { viewport: { width: w, height: h }, theme: 'dark' });
    await t.step(`${w}x${h}: dashboard layout`, async () => {
      await t.loginAs(OWNER);
      await t.page.waitForTimeout(800);
      const m = await t.page.evaluate(() => {
        const main = document.querySelector('.main').getBoundingClientRect();
        const content = document.querySelector('.content').getBoundingClientRect();
        const chartCard = document.querySelector('.chart-box')?.closest('.card')?.getBoundingClientRect();
        const canvas = document.querySelector('.chart-box canvas')?.getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          zoom: parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
          gapLeft: content.left - main.left,
          gapRight: main.right - content.right,
          chartInside: !chartCard || !canvas || canvas.right <= chartCard.right + 1,
        };
      });
      if (m.scrollWidth > w + 1) throw new Error(`page scrolls sideways (${m.scrollWidth}px in a ${w}px window)`);
      if (Math.abs(m.zoom - expectedZoom) > 0.01) throw new Error(`zoom ${m.zoom}, expected ${expectedZoom}`);
      if (Math.abs(m.gapLeft - m.gapRight) > 40) throw new Error(`content not centred (gaps ${Math.round(m.gapLeft)} / ${Math.round(m.gapRight)})`);
      if (!m.chartInside) throw new Error('dashboard chart overflows its card');
      const box = await t.page.locator('.chart-box').boundingBox();
      await t.page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6); // hover a bar so the screenshot shows a tooltip
      await t.page.waitForTimeout(400);
      await t.page.screenshot({ path: `${out}/wide-${w}.png` });
    });
    await t.step(`${w}x${h}: menu and pop-up fit`, async () => {
      await t.page.click('button[aria-label="Settings menu"]');
      const menu = await t.page.locator('.gear-menu, .menu-panel, [role=menu]').first().boundingBox().catch(() => null);
      if (menu && menu.x + menu.width > w + 1) throw new Error('settings menu runs off screen');
      await t.go('/customers');
      await t.page.click('button:has-text("New customer")');
      const modal = await t.page.locator('.modal').boundingBox();
      if (modal.x < 0 || modal.x + modal.width > w || modal.y + 40 > h) throw new Error('pop-up window does not fit on screen');
    });
    await t.finish(`Wide ${w}x${h}`);
  }
})();
