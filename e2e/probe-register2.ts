/**
 * Second registration attempt: use a TRUSTED Playwright click (real user
 * gesture, required for WebAuthn create()) on the widget Register button, and
 * watch for navigations/popups + the WebAuthn challenge.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL ?? 'https://githaiku.localhost/owner';
const CRED_FILE = resolve(__dirname, '.passkey.json');
const lines: string[] = [];
const log = (l: string) => {
  console.log(l);
  lines.push(l);
};

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable', { enableUI: false });
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
cdp.on('WebAuthn.credentialAdded', () => log('[webauthn] credentialAdded'));

context.on('page', async (p) => {
  log(`[popup opened] ${p.url()}`);
  p.on('framenavigated', (f) => log(`[popup nav] ${f.url()}`));
});
page.on('framenavigated', (f) => {
  if (f.url().includes('openkey')) log(`[frame nav] ${f.url()}`);
});

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /sign in with openkey/i }).click();
await page.waitForTimeout(6000);

// Locate the openkey frame and trusted-click Register by bounding box.
const okFrame = page.frames().find((f) => f.url().includes('openkey.so'));
if (!okFrame) {
  log('no openkey frame');
} else {
  const handle = await okFrame.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim().toLowerCase() === 'register',
    );
  });
  const el = handle.asElement();
  if (el) {
    log('trusted-clicking Register');
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true }).catch((e) => log(`click err ${e}`));
  } else {
    log('Register element handle null');
  }
}

await page.waitForTimeout(8000);

// Report widget state + any popups.
const okFrame2 = page.frames().find((f) => f.url().includes('openkey.so'));
if (okFrame2) {
  const state = await okFrame2
    .evaluate(() => ({
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 250),
      inputs: Array.from(document.querySelectorAll('input')).map((i) => i.type + ':' + i.placeholder),
    }))
    .catch((e) => ({ url: 'err', text: String(e), inputs: [] }));
  log(`widget state: ${JSON.stringify(state)}`);
}
log(`open pages: ${context.pages().map((p) => p.url()).join(' , ')}`);

const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
log(`credentials captured: ${creds.credentials.length}`);
if (creds.credentials.length > 0) writeFileSync(CRED_FILE, JSON.stringify(creds.credentials, null, 2));

writeFileSync(resolve(__dirname, '.register2.log'), lines.join('\n'));
if (process.env.KEEP_OPEN !== '1') await browser.close();
