/**
 * Drive the OpenKey /auth/register popup: inspect its form, fill email if
 * present, submit, and watch for the WebAuthn registration challenge (answered
 * by the virtual authenticator) → captured credential. If this works the whole
 * combo is automatable unattended.
 */
import { chromium, type Page } from 'playwright';
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
cdp.on('WebAuthn.credentialAdded', () => log('[webauthn] credentialAdded — passkey registered!'));

const popupPromise = context.waitForEvent('page', { timeout: 30000 });

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /sign in with openkey/i }).click();
await page.waitForTimeout(6000);

const okFrame = page.frames().find((f) => f.url().includes('openkey.so'))!;
const handle = await okFrame.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim().toLowerCase() === 'register'),
);
await handle.asElement()!.click({ force: true });
log('clicked Register; waiting for signup popup');

let popup: Page;
try {
  popup = await popupPromise;
} catch {
  log('no popup appeared');
  await browser.close();
  process.exit(1);
}
await popup.waitForLoadState('domcontentloaded').catch(() => {});
await popup.waitForTimeout(2500);
log(`popup url: ${popup.url()}`);
popup.on('console', (m) => log(`[popup console ${m.type()}] ${m.text().slice(0, 160)}`));

const form = await popup
  .evaluate(() => ({
    text: (document.body?.innerText ?? '').slice(0, 300),
    inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
      type: i.type,
      name: i.name,
      placeholder: i.placeholder,
      id: i.id,
    })),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim()),
  }))
  .catch((e) => ({ text: `err:${e}`, inputs: [], buttons: [] }));
log(`SIGNUP FORM text: ${form.text.replace(/\n+/g, ' | ')}`);
log(`SIGNUP FORM inputs: ${JSON.stringify(form.inputs)}`);
log(`SIGNUP FORM buttons: ${JSON.stringify(form.buttons)}`);

// Try to fill any text/email inputs + submit.
const email = `githaiku-e2e-${Date.now()}@example.com`;
for (const inp of form.inputs as Array<{ type: string }>) {
  if (['email', 'text'].includes(inp.type)) {
    await popup.fill(`input[type="${inp.type}"]`, email).catch(() => {});
    log(`filled ${inp.type} = ${email}`);
  }
}
const submitName = (form.buttons as string[]).find((b) => /register|create|sign up|continue|passkey/i.test(b));
if (submitName) {
  log(`clicking submit: ${submitName}`);
  await popup.getByRole('button', { name: new RegExp(submitName, 'i') }).first().click().catch((e) => log(`submit err ${e}`));
}

await popup.waitForTimeout(8000);
log(`popup after submit: ${(await popup.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 250).replace(/\n+/g, ' | ')}`);

// Did the app advance?
const appText = await page.evaluate(() => document.body.innerText).catch(() => '');
log(`APP TEXT: ${appText.slice(0, 250).replace(/\n+/g, ' | ')}`);

const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
log(`credentials captured: ${creds.credentials.length}`);
if (creds.credentials.length > 0) {
  writeFileSync(CRED_FILE, JSON.stringify(creds.credentials, null, 2));
  log(`saved ${CRED_FILE}`);
}

writeFileSync(resolve(__dirname, '.signup-popup.log'), lines.join('\n'));
if (process.env.KEEP_OPEN !== '1') await browser.close();
