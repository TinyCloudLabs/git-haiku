/**
 * Drive the requester UI end-to-end against the live local backend: enter a
 * code, click Get Haiku, capture the rendered haiku + the MCP panel.
 */
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'https://githaiku.localhost/';
const CODE = process.env.CODE ?? '';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.on('response', async (res) => {
  if (res.url().includes('/api/haiku')) {
    console.log(`[res ${res.status()}] /api/haiku :: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
});

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
// Landing → requester.
const getBtn = page.getByRole('button', { name: /get a haiku/i }).first();
await getBtn.click();
await page.getByLabel('secret code').waitFor({ timeout: 10000 });
await page.getByLabel('secret code').fill(CODE);
await page.getByRole('button', { name: /get haiku/i }).click();
await page.waitForTimeout(12000);

const haiku = await page.locator('.haiku').innerText().catch(() => '<none>');
console.log('HAIKU:', haiku.replace(/\n+/g, ' / '));
const mcp = await page.getByText(/use it from an agent/i).count();
console.log('MCP panel present:', mcp > 0);
await browser.close();
