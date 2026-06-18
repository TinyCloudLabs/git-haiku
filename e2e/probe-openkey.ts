/**
 * OpenKey-combo probe for Git Haiku.
 *
 * Drives the REAL frontend owner flow in a Chromium with a CDP virtual WebAuthn
 * authenticator. If a captured credential exists (.passkey.json) it is loaded so
 * the passkey gate auto-answers; otherwise we still drive the flow to observe
 * exactly where the OpenKey + web-sdk + SIWE chain stops.
 *
 * Captures: console, page errors, and the request/response for /api/server-info,
 * /api/auth/nonce, /api/delegations, /api/owner, /api/codes, /api/haiku, plus
 * any openkey.so iframe traffic. Writes .probe-run.log.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = resolve(__dirname, '.passkey.json');
const LOG_FILE = resolve(__dirname, '.probe-run.log');
const APP_URL = process.env.APP_URL ?? 'https://githaiku.localhost/owner';

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
log(`virtual authenticator: ${authenticatorId}`);

if (existsSync(CRED_FILE)) {
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  for (const credential of creds) {
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  log(`loaded ${creds.length} saved credential(s)`);
} else {
  log('no .passkey.json — passkey gate will not auto-answer (registration is interactive)');
}

const WATCH = /\/(api\/server-info|api\/auth\/nonce|api\/delegations|api\/owner|api\/codes|api\/haiku)/;

context.on('page', (p) => {
  log(`[popup] ${p.url()}`);
  p.on('console', (m) => log(`[popup console ${m.type()}] ${m.text()}`));
});
page.on('console', (m) => log(`[console ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
page.on('frameattached', (f) => log(`[frame] ${f.url()}`));
page.on('request', (req) => {
  if (WATCH.test(req.url()) || req.url().includes('openkey')) log(`[req] ${req.method()} ${req.url()}`);
});
page.on('response', async (res) => {
  if (WATCH.test(res.url())) {
    const body = await res.text().catch(() => '<no body>');
    log(`[res ${res.status()}] ${res.request().method()} ${res.url()} :: ${body.slice(0, 300)}`);
  }
});

log(`opening ${APP_URL}`);
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

const signInBtn = page.getByRole('button', { name: /sign in with openkey/i });
try {
  await signInBtn.waitFor({ timeout: 10_000 });
  log('found "Sign in with OpenKey" button — clicking');
  await signInBtn.click();
} catch {
  log('ERROR: sign-in button not found on /owner');
}

// Observe for up to 60s: a signed-in dashboard, a setup form, or an error.
const outcome = await Promise.race([
  page
    .waitForFunction(() => /set up your haiku source|owner dashboard/i.test(document.body.innerText), { timeout: 60_000 })
    .then(() => 'reached-setup-or-dashboard' as const)
    .catch(() => null),
  page
    .waitForFunction(() => /sign-in failed|error|failed/i.test(document.body.innerText), { timeout: 60_000 })
    .then(() => 'error-shown' as const)
    .catch(() => null),
]);
log(`OUTCOME: ${outcome ?? 'timeout'}`);

const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
log(`PAGE TEXT (truncated): ${bodyText.slice(0, 400).replace(/\n+/g, ' | ')}`);

writeFileSync(LOG_FILE, lines.join('\n'));
log(`wrote ${LOG_FILE}`);

if (process.env.KEEP_OPEN !== '1') await browser.close();
