/**
 * Attempt UNATTENDED OpenKey passkey registration via the in-widget "Register"
 * button + the virtual WebAuthn authenticator, then observe whether the app's
 * `openkey.connect()` resolves (→ the owner setup form appears). If it does, the
 * full OpenKey combo is automatable and we capture .passkey.json for reuse.
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
cdp.on('WebAuthn.credentialAdded', () => log('[webauthn] credentialAdded — registration challenge answered'));
cdp.on('WebAuthn.credentialAsserted', () => log('[webauthn] credentialAsserted — assertion answered'));

page.on('console', (m) => {
  const t = m.text();
  if (/openkey|siwe|delegat|secret|error|sign/i.test(t)) log(`[console ${m.type()}] ${t}`);
});
page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
page.on('response', async (res) => {
  if (/\/api\/(server-info|auth\/nonce|owner|delegations|codes)/.test(res.url())) {
    const b = await res.text().catch(() => '');
    log(`[res ${res.status()}] ${res.url()} :: ${b.slice(0, 200)}`);
  }
});

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /sign in with openkey/i }).click();
log('clicked app sign-in; waiting for widget…');

// Find the OpenKey iframe (via page.frames, which resolved reliably) and click
// its "Register" button by walking the DOM inside the frame.
await page.waitForTimeout(6000);
const okFrame = page.frames().find((f) => f.url().includes('openkey.so'));
if (!okFrame) {
  log('ERROR: no openkey.so frame attached');
} else {
  log(`widget frame: ${okFrame.url()}`);
  const clicked = await okFrame
    .evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim().toLowerCase() === 'register',
      );
      if (btn) {
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    })
    .catch((e) => `err:${e}`);
  log(`clicked Register in widget: ${clicked}`);
}

// Some flows show an email/username step after Register; fill if present.
await page.waitForTimeout(3000);
if (okFrame) {
  const after = await okFrame
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((i) => ({
        type: i.type,
        name: i.name,
        placeholder: i.placeholder,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());
      const text = (document.body?.innerText ?? '').slice(0, 200);
      return { inputs, buttons, text };
    })
    .catch((e) => ({ inputs: [], buttons: [], text: `err:${e}` }));
  log(`widget after Register — inputs: ${JSON.stringify(after.inputs)} buttons: ${JSON.stringify(after.buttons)}`);
  log(`widget text: ${after.text.replace(/\n+/g, ' | ')}`);

  const emailInput = (after.inputs as Array<{ type: string }>).find((i) => i.type === 'email');
  if (emailInput) {
    const addr = `githaiku-e2e-${Date.now()}@example.com`;
    await okFrame.evaluate((a) => {
      const el = document.querySelector('input[type="email"]') as HTMLInputElement | null;
      if (el) {
        el.value = a;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, addr);
    log(`filled email ${addr}`);
    await okFrame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /continue|register|create|next/i.test(b.textContent ?? ''),
      );
      (btn as HTMLButtonElement | undefined)?.click();
    });
  }
}

// Observe up to 45s for the app to advance past sign-in.
const outcome = await Promise.race([
  page
    .waitForFunction(() => /set up your haiku source|owner dashboard/i.test(document.body.innerText), { timeout: 45000 })
    .then(() => 'reached-setup' as const)
    .catch(() => null),
  page
    .waitForFunction(() => /sign-in failed|server-info|error/i.test(document.body.innerText), { timeout: 45000 })
    .then(() => 'app-error' as const)
    .catch(() => null),
]);
log(`OUTCOME: ${outcome ?? 'timeout'}`);

const text = await page.evaluate(() => document.body.innerText).catch(() => '');
log(`APP TEXT: ${text.slice(0, 500).replace(/\n+/g, ' | ')}`);

const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
log(`credentials captured: ${creds.credentials.length}`);
if (creds.credentials.length > 0) {
  writeFileSync(CRED_FILE, JSON.stringify(creds.credentials, null, 2));
  log(`saved ${CRED_FILE}`);
}

writeFileSync(resolve(__dirname, '.register-probe.log'), lines.join('\n'));
if (process.env.KEEP_OPEN !== '1') await browser.close();
