import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = resolve(__dirname, ".passkey.json");
const LOG_FILE = resolve(__dirname, ".last-run.log");
const APP_URL = process.env.APP_URL ?? "https://localhost:5173/";

if (!existsSync(CRED_FILE)) {
  console.error(`No credentials at ${CRED_FILE}. Run \`bun run setup\` first.`);
  process.exit(1);
}

const credentials = JSON.parse(readFileSync(CRED_FILE, "utf-8"));

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

await cdp.send("WebAuthn.enable", { enableUI: false });
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

for (const credential of credentials) {
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
}

const lines: string[] = [];
const log = (line: string) => { console.log(line); lines.push(line); };

context.on("page", (p) => {
  log(`[popup] ${p.url()}`);
  p.on("console", (msg) => log(`[popup console ${msg.type()}] ${msg.text()}`));
});

page.on("console", (msg) => log(`[console ${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => log(`[pageerror] ${err.message}`));

page.on("request", (req) => {
  if (/\/(delegate|api\/delegations|api\/server-info|nonce|verify)/.test(req.url())) {
    log(`[req] ${req.method()} ${req.url()}`);
    const auth = req.headers()["authorization"];
    if (auth) log(`  authorization: ${auth.slice(0, 80)}...`);
  }
});

page.on("response", async (res) => {
  if (/\/(delegate|api\/delegations|api\/server-info|nonce|verify)/.test(res.url())) {
    const body = await res.text().catch(() => "<no body>");
    log(`[res ${res.status()}] ${res.request().method()} ${res.url()}`);
    log(`  body: ${body.slice(0, 500)}${body.length > 500 ? "..." : ""}`);
  }
});

log(`Opening ${APP_URL}`);
await page.goto(APP_URL);

const signInBtn = page.getByRole("button", { name: /sign in/i });
await signInBtn.waitFor({ timeout: 10_000 });
log("Clicking Sign In");
await signInBtn.click();

const ok = await Promise.race([
  page
    .waitForFunction(() => /signed in|connected|address/i.test(document.body.innerText), { timeout: 90_000 })
    .then(() => "signed-in" as const)
    .catch(() => null),
  page
    .waitForFunction(() => /error|failed|401|403/i.test(document.body.innerText), { timeout: 90_000 })
    .then(() => "error" as const)
    .catch(() => null),
]);

log(`Outcome: ${ok ?? "timeout"}`);

writeFileSync(LOG_FILE, lines.join("\n"));
log(`Wrote diagnostics to ${LOG_FILE}`);

if (process.env.KEEP_OPEN !== "1") await browser.close();
