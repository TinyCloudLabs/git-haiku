/**
 * Full OpenKey → haiku E2E driver (the hard gate).
 *
 * REQUIRES a captured .passkey.json (run `bun setup-passkey.ts` once — a human
 * completes OpenKey's email-OTP + passkey registration; the credential is then
 * reused unattended). REQUIRES the stack in tc-cli mode (see e2e/run-stack.sh):
 *   - local tinycloud-node, backend with GITHAIKU_SECRETS_PROVIDER=tc-cli,
 *     GITHAIKU_BACKEND_PRIVATE_KEY set, frontend at APP_URL.
 *
 * Drives: OpenKey passkey sign-in → owner setup form (GITHUB_TOKEN) →
 * secrets.put + delegation → mint code (dashboard) → requester gets a haiku.
 * Captures all evidence to .full-flow.log.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = resolve(__dirname, '.passkey.json');
const LOG_FILE = resolve(__dirname, '.full-flow.log');
const APP_URL = process.env.APP_URL ?? 'https://githaiku.localhost/owner';
const GITHUB_LOGIN = process.env.GH_LOGIN ?? 'octocat';
const GITHUB_TOKEN = process.env.GH_TOKEN ?? 'ghp_e2e_fixture_0123456789abcdefABCDEF';

const lines: string[] = [];
const log = (l: string) => {
  console.log(l);
  lines.push(l);
};

if (!existsSync(CRED_FILE)) {
  log(`BLOCKED: no ${CRED_FILE}. Run \`bun setup-passkey.ts\` once (human email-OTP) first.`);
  writeFileSync(LOG_FILE, lines.join('\n'));
  process.exit(2);
}

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
for (const credential of JSON.parse(readFileSync(CRED_FILE, 'utf-8'))) {
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
}
log('loaded saved passkey credential');

page.on('console', (m) => {
  if (/error|fail|delegat|secret|siwe/i.test(m.text())) log(`[console ${m.type()}] ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
page.on('response', async (res) => {
  if (/\/api\/(server-info|auth\/nonce|owner|delegations|codes|haiku)/.test(res.url())) {
    const b = await res.text().catch(() => '');
    log(`[res ${res.status()}] ${res.request().method()} ${res.url()} :: ${b.slice(0, 220)}`);
  }
});

// 1. OpenKey passkey sign-in.
log(`opening ${APP_URL}`);
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /sign in with openkey/i }).click();
log('clicked sign-in; passkey auto-asserts via virtual authenticator');

// 2. Setup form.
await page.getByPlaceholder('octocat').waitFor({ timeout: 90_000 });
log('reached setup form');
await page.getByPlaceholder('octocat').fill(GITHUB_LOGIN);
await page.getByPlaceholder('ghp_…').fill(GITHUB_TOKEN);
await page.getByRole('button', { name: /authorize & generate code/i }).click();
log('submitted setup (secrets.put + delegation)');

// 3. Dashboard appears with the first code.
await page.getByText(/owner dashboard/i).waitFor({ timeout: 90_000 });
log('reached dashboard');
const code = await page
  .locator('.code-pill')
  .first()
  .textContent()
  .catch(() => null);
log(`minted code: ${code}`);

// 4. Requester gets a haiku.
if (code) {
  await page.goto(APP_URL.replace('/owner', '/'), { waitUntil: 'domcontentloaded' });
  await page.getByText(/get a haiku/i).first().click();
  await page.getByLabel('secret code').fill(code.trim());
  await page.getByRole('button', { name: /get haiku/i }).click();
  await page.waitForTimeout(8000);
  const haikuText = await page
    .locator('.haiku')
    .innerText()
    .catch(() => '<no haiku element>');
  log(`HAIKU RESULT: ${haikuText.replace(/\n+/g, ' / ')}`);
}

writeFileSync(LOG_FILE, lines.join('\n'));
log(`wrote ${LOG_FILE}`);
if (process.env.KEEP_OPEN !== '1') await browser.close();
