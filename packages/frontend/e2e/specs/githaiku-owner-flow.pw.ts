import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Headless Git Haiku owner-flow e2e.
 *
 * Drives the FULL owner flow against the deployed app (https://githaiku.com →
 * live backend api.githaiku.com) with NO human and NO passkey: OpenKey's "or use
 * an external wallet" option is wired to a mock EIP-1193 / EIP-6963 wallet backed
 * by an ethers v5 Wallet. Every signature the flow needs is auto-signed by the
 * mock wallet.
 *
 * Two scenarios:
 *   1. FRESH owner (random wallet) — exercises the full SETUP path: lightweight
 *      login signature → setup form → recap signature → secrets.put + register +
 *      delegate → dashboard → preview. New owners pay TWO signatures (login +
 *      setup recap).
 *   2. RETURNING owner (FIXED anvil key) — proves the lightweight path: ONE login
 *      signature lands DIRECTLY on the dashboard (no setup form, no token
 *      re-upload). It mints a new code and previews a haiku using only the backend
 *      JWT. The test self-bootstraps: if the fixed key has no owner record yet, it
 *      runs setup once, then RELOADS and re-signs-in to assert the returning path.
 *
 * Mirrors secret-manager's openkey-wallet-secret-flow harness (the blessed
 * reference). git-haiku-side selectors are testid-OR-text resilient (the deployed
 * bundle may predate a given data-testid); only the OpenKey iframe is matched
 * purely by text (its DOM we don't control).
 */

// The fixed anvil key #0 — the RETURNING-owner identity. Stable across runs so a
// prior run's setup persists, exercising the dashboard-direct login path.
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ETHERS_UMD_PATH = fileURLToPath(
  new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url),
);

const TEST_WALLET_NAME = "TinyCloud Test Wallet";

// ── Test inputs from the gitignored .githaiku-dev/e2e.env (NEVER printed) ──────
function loadE2eEnv(): { githubToken: string } {
  const envPath = fileURLToPath(new URL("../../../../.githaiku-dev/e2e.env", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (err) {
    throw new Error(
      `Missing .githaiku-dev/e2e.env (expected at ${envPath}). It must define ` +
        `GITHAIKU_E2E_GITHUB_TOKEN.`,
    );
  }
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const githubToken = process.env.GITHAIKU_E2E_GITHUB_TOKEN ?? vars.GITHAIKU_E2E_GITHUB_TOKEN ?? "";
  if (!githubToken) throw new Error("GITHAIKU_E2E_GITHUB_TOKEN is empty");
  return { githubToken };
}

// ── init scripts (replicated EXACTLY from secret-manager) ──────────────────────

function exposeTestShadowRoots() {
  return () => {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    };
  };
}

function mockBrowserWalletProvider() {
  return ({
    address,
    privateKey,
    walletName,
  }: {
    address: string;
    privateKey: string;
    walletName: string;
  }) => {
    const requests: string[] = [];
    const ethers = (window as any).ethers;
    const wallet = new ethers.Wallet(privateKey);
    const provider = {
      selectedAddress: address,
      chainId: "0x1",
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        requests.push(method);
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return "0x1";
          case "personal_sign": {
            const message = params?.[0];
            if (typeof message !== "string") {
              throw new Error("personal_sign missing message");
            }
            if (message.startsWith("0x")) {
              return wallet.signMessage(ethers.utils.arrayify(message));
            }
            return wallet.signMessage(message);
          }
          case "wallet_getPermissions":
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            return null;
        }
      },
      on: () => provider,
      removeListener: () => provider,
      isConnected: () => true,
    };
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "8fd9b04a-e8a0-4c43-9d87-5af504aa1f0d",
              name: walletName,
              icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect width='28' height='28' rx='6' fill='%23111827'/%3E%3Ctext x='14' y='18' text-anchor='middle' font-size='11' font-family='Arial' fill='white'%3ETC%3C/text%3E%3C/svg%3E",
              rdns: "xyz.tinycloud.test-wallet",
            },
            provider,
          },
        }),
      );
    };

    Object.defineProperty(window, "ethereum", {
      value: provider,
      configurable: true,
    });
    Object.defineProperty(window, "__walletRequests", {
      value: requests,
      configurable: true,
    });
    window.addEventListener("eip6963:requestProvider", announceProvider);
    announceProvider();
  };
}

// ── testid-OR-text resilient locators for the git-haiku UI ─────────────────────

function firstVisible(...locators: Locator[]): Locator {
  // `.or()` chains so Playwright resolves to whichever matches.
  return locators.reduce((acc, l) => acc.or(l));
}

function tokenInputLoc(page: Page): Locator {
  return firstVisible(page.getByTestId("setup-github-token"), page.getByPlaceholder("ghp_…"));
}
function removedLoginInputLoc(page: Page): Locator {
  return firstVisible(page.getByTestId("setup-github-login"), page.getByPlaceholder("octocat"));
}
function previewButtonLoc(page: Page): Locator {
  return firstVisible(
    page.getByTestId("preview-run"),
    page.getByRole("button", { name: /preview \/ test haiku/i }),
  );
}
function authorizeButtonLoc(page: Page): Locator {
  return firstVisible(
    page.getByTestId("setup-authorize"),
    page.getByRole("button", { name: /authorize & generate code/i }),
  );
}
function haikuLinesLoc(page: Page): Locator {
  return firstVisible(page.getByTestId("haiku-line"), page.locator(".haiku .haiku-line"));
}

/**
 * A first-time owner address has no TinyCloud space yet, so the web-sdk's
 * UserAuthorization shows a "Create Your TinyCloud Space" modal mid-recap (the
 * `ensureSpaceExists` step). Auto-click it whenever it surfaces. Detached
 * background loop so it also catches the modal if it re-appears during
 * secrets.put. Best-effort: stops once the page closes.
 */
function autoCreateSpaceOnModal(page: Page): void {
  const createButton = page.getByRole("button", { name: /create tinycloud space/i });
  void (async () => {
    while (!page.isClosed()) {
      try {
        await createButton.click({ timeout: 5000 });
      } catch {
        await page.waitForTimeout(1000).catch(() => {});
      }
    }
  })();
}

async function installWallet(
  page: Page,
  wallet: { address: string; privateKey: string },
): Promise<void> {
  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: wallet.address,
    privateKey: wallet.privateKey,
    walletName: TEST_WALLET_NAME,
  });
}

function logAppApiErrors(page: Page): void {
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (status < 400) return;
    const isAppApi = url.includes("api.githaiku.com");
    const isNodeServerError = url.includes("node.tinycloud.xyz") && status >= 500;
    if (isAppApi || isNodeServerError) console.log(`[http ${status}] ${url}`);
  });
}

async function signIn(page: Page): Promise<void> {
  const button = firstVisible(
    page.getByTestId("owner-signin"),
    page.getByRole("button", { name: /sign in with openkey/i }),
  );
  await button.click();

  // OpenKey connect widget (third-party iframe — matched by text only).
  await page
    .frameLocator('iframe[src*="openkey.so/widget/embed/connect"]')
    .getByText(/or use an external wallet/i)
    .click();
  await expect(page.getByText(TEST_WALLET_NAME)).toBeVisible();
  await page.getByText(TEST_WALLET_NAME).click();
}

/**
 * Run the SETUP form: fill token, submit, ride the bounded
 * space-not-found retry loop, and converge on the dashboard. Bounded retries
 * mirror a human re-clicking Authorize when the just-created space hasn't
 * propagated to the live node yet.
 */
async function runSetup(
  page: Page,
  githubToken: string,
): Promise<void> {
  await expect(removedLoginInputLoc(page)).toHaveCount(0);
  await tokenInputLoc(page).fill(githubToken);
  const authorize = authorizeButtonLoc(page);
  const previewButton = previewButtonLoc(page);
  const denial = page.locator(".denial");
  const spaceNotFound = denial.filter({ hasText: /space not found/i });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await authorize.click();
    await expect(previewButton.or(spaceNotFound).first()).toBeVisible({ timeout: 90000 });
    if (await previewButton.isVisible()) break;
    if (await spaceNotFound.isVisible()) {
      console.log(`[flow] space-not-found (attempt ${attempt}) — retrying authorize`);
      await page.waitForTimeout(3000);
    }
  }
}

type PreviewOutcome = { ok: true; lines: string[] } | { ok: false; reason: string };

/**
 * Click Preview once and resolve to the 3-line haiku OR the on-page denial
 * reason. Does NOT throw on denial — the caller decides (a stale stored token is
 * recoverable via re-store; a generate-stage RedPill timeout is retryable).
 */
async function previewOnce(page: Page): Promise<PreviewOutcome> {
  const previewButton = previewButtonLoc(page);
  await previewButton.click();
  const haikuLines = haikuLinesLoc(page);
  const previewDenial = page.locator(".card", { has: previewButton }).locator(".denial");
  await expect(haikuLines.first().or(previewDenial)).toBeVisible({ timeout: 180000 });
  if (await previewDenial.isVisible()) {
    return { ok: false, reason: (await previewDenial.innerText()).trim() };
  }
  await expect(haikuLines).toHaveCount(3);
  const lines = await haikuLines.allInnerTexts();
  expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(3);
  return { ok: true, lines };
}

/**
 * Run Preview and assert a 3-line haiku. Retries a transient generate-stage
 * failure (the prod RedPill LLM gateway intermittently times out — an upstream
 * latency issue, not a flow bug) a bounded number of times before failing with
 * the actionable on-page reason.
 */
async function previewHaiku(page: Page): Promise<string[]> {
  let lastReason = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const outcome = await previewOnce(page);
    if (outcome.ok) return outcome.lines;
    lastReason = outcome.reason;
    const transient = /try again|generate the haiku/i.test(outcome.reason);
    if (!transient) break;
    console.log(`[flow] preview generate-stage retry (attempt ${attempt}): "${outcome.reason}"`);
    await page.waitForTimeout(4000);
  }
  throw new Error(
    `Preview did not produce a haiku — backend denied at the preview stage: "${lastReason}". ` +
      `Check the backend logs (phala cvms logs <git-haiku-prod> -c dstack-githaiku-backend-1).`,
  );
}

// ── Scenario 1: FRESH owner → full setup path ──────────────────────────────────

test("fresh owner signs in, sets up, and produces a haiku", async ({ page }) => {
  const { githubToken } = loadE2eEnv();
  const owner = Wallet.createRandom();
  const addressSuffix = owner.address.slice(-8);

  logAppApiErrors(page);
  await installWallet(page, owner);
  autoCreateSpaceOnModal(page);

  // ── PART 1: land on the owner view and sign in via the external wallet ──────
  await page.goto("/owner");
  await signIn(page);

  // ── PART 2: a fresh owner has no record → SETUP form ────────────────────────
  await expect(tokenInputLoc(page)).toBeVisible({ timeout: 120000 });
  await expect(removedLoginInputLoc(page)).toHaveCount(0);
  console.log("[flow] fresh owner → setup form");

  // ── PART 3: authorize (recap sig) → secrets.put + register + delegate ───────
  await runSetup(page, githubToken);

  // Dashboard arrival.
  await expect(previewButtonLoc(page)).toBeVisible({ timeout: 180000 });
  const addressDisplay = firstVisible(
    page.getByTestId("owner-address"),
    page.getByText(addressSuffix).first(),
  );
  await expect(addressDisplay).toBeVisible();

  // ── PART 4: preview → an allowed 3-line haiku ───────────────────────────────
  const lines = await previewHaiku(page);
  console.log("─── fresh-owner haiku ───");
  for (const line of lines) console.log(line);
  console.log("─────────────────────────");

  // ── PART 5: the mock wallet signed (login + recap) ──────────────────────────
  await expect
    .poll(() => page.evaluate(() => (window as any).__walletRequests))
    .toContain("personal_sign");
});

// ── Scenario 2: RETURNING owner → lightweight login lands on the dashboard ─────

test("returning owner just signs in and lands on the dashboard (no setup, no token re-upload)", async ({
  page,
}) => {
  const { githubToken } = loadE2eEnv();
  const owner = new Wallet(process.env.GITHAIKU_E2E_PRIVATE_KEY ?? ANVIL_KEY_0);
  const addressSuffix = owner.address.slice(-8);

  logAppApiErrors(page);
  await installWallet(page, owner);
  autoCreateSpaceOnModal(page);

  // ── PART 1: sign in ─────────────────────────────────────────────────────────
  await page.goto("/owner");
  await signIn(page);

  // ── PART 2: self-bootstrap — if this fixed key has never been set up, the
  // app routes to the SETUP form; run setup ONCE so a prior-run record exists.
  // Then RELOAD and re-sign-in to assert the RETURNING path from a clean slate.
  await expect(tokenInputLoc(page).or(previewButtonLoc(page)).first()).toBeVisible({
    timeout: 120000,
  });
  if (await tokenInputLoc(page).isVisible()) {
    console.log("[flow] returning key not yet set up → running setup once to seed it");
    await runSetup(page, githubToken);
    await expect(previewButtonLoc(page)).toBeVisible({ timeout: 180000 });

    // Fresh page + fresh wallet-request log: now assert the lightweight login.
    await page.reload();
    await signIn(page);
  } else {
    console.log("[flow] returning owner already set up → dashboard directly");
  }

  // ── PART 3: assert the RETURNING (dashboard-direct) path ────────────────────
  // The dashboard's Preview button is present; the setup token field is NOT.
  await expect(previewButtonLoc(page)).toBeVisible({ timeout: 120000 });
  await expect(tokenInputLoc(page)).toHaveCount(0);
  await expect(removedLoginInputLoc(page)).toHaveCount(0);

  const addressDisplay = firstVisible(
    page.getByTestId("owner-address"),
    page.getByText(addressSuffix).first(),
  );
  await expect(addressDisplay).toBeVisible();

  // Existing codes are listed (the record minted at least one at registration).
  const codesTable = page.locator(".table").first();
  await expect(codesTable).toBeVisible({ timeout: 60000 });
  const codeRowsBefore = await codesTable.locator("tbody tr").count();
  expect(codeRowsBefore).toBeGreaterThanOrEqual(1);

  // ── PART 4: mint a NEW code — a backend JWT call, no token, no recap ─────────
  const mintButton = page.getByRole("button", { name: /mint new code/i });
  await mintButton.click();
  // The "New code — shown once" card surfaces the freshly minted code.
  await expect(page.getByText(/new code — shown once/i)).toBeVisible({ timeout: 60000 });
  await expect
    .poll(async () => codesTable.locator("tbody tr").count(), { timeout: 60000 })
    .toBeGreaterThan(codeRowsBefore);

  // ── PART 5: the login was a personal_sign, and the dashboard NEVER showed a
  // token field — proving the returning path didn't require re-uploading the
  // token. (Asserted BEFORE preview, while we're guaranteed on the dashboard.)
  await expect
    .poll(() => page.evaluate(() => (window as any).__walletRequests))
    .toContain("personal_sign");
  await expect(tokenInputLoc(page)).toHaveCount(0);

  // ── PART 6: preview → an allowed 3-line haiku, reusing the STORED token ──────
  // The returning owner reuses whatever token is already in their vault. If that
  // token is stale (a prior run stored a now-expired one) the preview denies at
  // the token/github stage — recover via the dashboard's "Rotate / re-store"
  // affordance (the real-world fix for an expired token), which runs the heavy
  // recap + secrets.put ONCE, then return to the dashboard and preview again.
  let outcome = await previewOnce(page);
  if (!outcome.ok && /github activity|stored token|re-store/i.test(outcome.reason)) {
    console.log(`[flow] stored token stale ("${outcome.reason}") → rotating via dashboard affordance`);
    const restore = firstVisible(
      page.getByTestId("dashboard-restore-token"),
      page.getByRole("button", { name: /rotate \/ re-store github token/i }),
    );
    await restore.click();
    await runSetup(page, githubToken);
    await expect(previewButtonLoc(page)).toBeVisible({ timeout: 180000 });
    outcome = { ok: false, reason: "" }; // fall through to the asserting preview
  }

  const lines = outcome.ok ? outcome.lines : await previewHaiku(page);
  console.log("─── returning-owner haiku ───");
  for (const line of lines) console.log(line);
  console.log("─────────────────────────────");
});
