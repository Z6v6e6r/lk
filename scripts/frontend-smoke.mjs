// Use the owner-selected existing public page. Never authenticate or submit a form.
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.LK_PLAYWRIGHT_ROOT}/package.json`);
const { chromium, webkit } = require('playwright');
const url = new URL(process.env.LK_FRONTEND_SMOKE_URL);
if (url.protocol !== 'https:') throw new Error('Public HTTPS smoke URL required');
const selector = process.env.LK_FRONTEND_SMOKE_SELECTOR;
if (!selector || !process.env.LK_FRONTEND_SMOKE_OPEN_SELECTOR || !process.env.LK_FRONTEND_SMOKE_RESULT_SELECTOR) throw new Error('Owner must select the visible login/read-only scenario');
for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Abort state-changing requests. The smoke proves public loading/read-only interaction.
    await page.route('**/*', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort());
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 30000 });
    const clickSelector = process.env.LK_FRONTEND_SMOKE_OPEN_SELECTOR;
    if (clickSelector) {
      await page.locator(clickSelector).first().click();
      const resultSelector = process.env.LK_FRONTEND_SMOKE_RESULT_SELECTOR;
      if (!resultSelector) throw new Error('Read-only navigation requires a result selector');
      await page.locator(resultSelector).first().waitFor({ state: 'visible', timeout: 30000 });
    }
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    if (!loaded.some(value => value.includes('/bundle.js?') && new URL(value).searchParams.get('v') === process.env.LK_SMOKE_VERSION)) throw new Error('Tilda did not load the expected versioned prod bundle');
    if (errors.length) throw new Error(`Browser script errors: ${errors.length}`);
  } finally { await browser.close(); }
}
