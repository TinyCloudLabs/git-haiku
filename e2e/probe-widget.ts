/**
 * Inspect the OpenKey connect widget to see whether account creation + passkey
 * registration can be driven unattended (does it expose an email/signup form,
 * or does it require an existing account?). Dumps the iframe DOM + any WebAuthn
 * challenge events.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL ?? 'https://githaiku.localhost/owner';
const lines: string[] = [];
const log = (l: string) => {
  console.log(l);
  lines.push(l);
};

const browser = await chromium.launch({ headless: true });
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
cdp.on('WebAuthn.credentialAdded', () => log('[webauthn] credentialAdded (registration challenge answered!)'));
cdp.on('WebAuthn.credentialAsserted', () => log('[webauthn] credentialAsserted (sign-in challenge answered!)'));
log(`authenticator ${authenticatorId}`);

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /sign in with openkey/i }).click();

// Let the widget load.
await page.waitForTimeout(8000);

for (const frame of page.frames()) {
  if (frame.url().includes('openkey')) {
    log(`\n=== OpenKey iframe: ${frame.url()} ===`);
    const text = await frame.evaluate(() => document.body?.innerText ?? '<no body>').catch((e) => `<err ${e}>`);
    log(`TEXT: ${text.replace(/\n+/g, ' | ')}`);
    const controls = await frame
      .evaluate(() => {
        const els = Array.from(document.querySelectorAll('input,button,a[role=button]'));
        return els.map((e) => ({
          tag: e.tagName,
          type: (e as HTMLInputElement).type ?? '',
          name: (e as HTMLInputElement).name ?? '',
          placeholder: (e as HTMLInputElement).placeholder ?? '',
          text: (e.textContent ?? '').trim().slice(0, 40),
        }));
      })
      .catch((e) => [`<err ${e}>`]);
    log(`CONTROLS: ${JSON.stringify(controls, null, 2)}`);
  }
}

const credsAfter = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
log(`\ncredentials captured: ${credsAfter.credentials.length}`);

writeFileSync(resolve(__dirname, '.widget-probe.log'), lines.join('\n'));
await browser.close();
