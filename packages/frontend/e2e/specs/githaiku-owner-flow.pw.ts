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
 * by an ethers v5 Wallet. Every signature the flow needs (the SIWE recap that
 * establishes the TinyCloud session + the backend session, plus the secrets.put
 * and delegation signatures) is auto-signed by the mock wallet.
 *
 * Owner identity: by default a FRESH random wallet per run, so the flow always
 * exercises the full SETUP path (secrets.put → register → delegate) and mints a
 * fresh delegation — never reusing a prior owner's persisted (and possibly stale)
 * delegation on the backend's volume. Pin a specific owner with
 * GITHAIKU_E2E_PRIVATE_KEY (e.g. anvil #0
 * 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80) to drive
 * the returning-owner path instead.
 *
 * Flow:
 *   1. inject shadow-open + ethers UMD + mock wallet
 *   2. goto /owner → "Sign in with OpenKey"
 *   3. OpenKey iframe → "or use an external wallet" → pick the mock wallet
 *   4. fresh owner has no record → SETUP form (returning owner → dashboard)
 *   5. fill GitHub login + token (from .githaiku-dev/e2e.env), submit → secrets.put
 *      + register + delegate → dashboard
 *   6. Preview → assert an allowed 3-line haiku
 *   7. assert window.__walletRequests contains personal_sign
 *
 * Mirrors secret-manager's openkey-wallet-secret-flow harness (the blessed
 * reference). The deployed git-haiku bundle predates the data-testids we add to
 * the components, so the git-haiku-side selectors are testid-OR-text resilient:
 * they use the committed testids when present and fall back to role/text against
 * the currently-deployed build. Only the OpenKey iframe is matched purely by text
 * (its DOM we don't control).
 */

// A fresh random owner each run (full setup path), unless pinned via env.
const ownerWallet = process.env.GITHAIKU_E2E_PRIVATE_KEY
  ? new Wallet(process.env.GITHAIKU_E2E_PRIVATE_KEY)
  : Wallet.createRandom();
const TEST_PRIVATE_KEY = ownerWallet.privateKey;
const TEST_ADDRESS = ownerWallet.address;
const TEST_WALLET_NAME = "TinyCloud Test Wallet";
// Last 8 hex of the owner address — what the dashboard's shortened did:pkh ends
// with (used as the no-testid fallback for the signed-in address display).
const ADDRESS_SUFFIX = TEST_ADDRESS.slice(-8);

const ETHERS_UMD_PATH = fileURLToPath(
  new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url),
);

// ── Test inputs from the gitignored .githaiku-dev/e2e.env (NEVER printed) ──────
function loadE2eEnv(): { githubLogin: string; githubToken: string } {
  const envPath = fileURLToPath(new URL("../../../../.githaiku-dev/e2e.env", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (err) {
    throw new Error(
      `Missing .githaiku-dev/e2e.env (expected at ${envPath}). It must define ` +
        `GITHAIKU_E2E_GITHUB_LOGIN and GITHAIKU_E2E_GITHUB_TOKEN.`,
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
  const githubLogin = process.env.GITHAIKU_E2E_GITHUB_LOGIN ?? vars.GITHAIKU_E2E_GITHUB_LOGIN ?? "";
  const githubToken = process.env.GITHAIKU_E2E_GITHUB_TOKEN ?? vars.GITHAIKU_E2E_GITHUB_TOKEN ?? "";
  if (!githubLogin) throw new Error("GITHAIKU_E2E_GITHUB_LOGIN is empty");
  if (!githubToken) throw new Error("GITHAIKU_E2E_GITHUB_TOKEN is empty");
  return { githubLogin, githubToken };
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
// The deployed bundle predates the committed data-testids, so each git-haiku
// selector prefers the testid (future deploys) and falls back to text/role
// (current deploy). Whichever exists is what we click.

function firstVisible(...locators: Locator[]): Locator {
  // `.or()` chains so Playwright resolves to whichever matches.
  return locators.reduce((acc, l) => acc.or(l));
}

/**
 * A first-time owner address has no TinyCloud space yet, so the web-sdk's
 * UserAuthorization shows a "Create Your TinyCloud Space" modal mid-sign-in (the
 * `ensureSpaceExists` step). A human clicks "Create TinyCloud Space"; here we
 * auto-click it whenever it surfaces. Runs as a detached background loop so it
 * also catches the modal if it re-appears during secrets.put. Best-effort: it
 * stops once the page closes.
 */
function autoCreateSpaceOnModal(page: Page): void {
  const createButton = page.getByRole("button", { name: /create tinycloud space/i });
  void (async () => {
    while (!page.isClosed()) {
      try {
        await createButton.click({ timeout: 5000 });
        // Re-loop: there may be a second prompt; if not, the next click times out
        // harmlessly and we keep polling.
      } catch {
        // No modal visible right now — poll again shortly.
        await page.waitForTimeout(1000).catch(() => {});
      }
    }
  })();
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

test("owner signs in with an OpenKey external wallet and produces a haiku", async ({ page }) => {
  const { githubLogin, githubToken } = loadE2eEnv();

  // Surface backend/API failures (never the token). Node capability probes 404
  // as a normal part of the flow, so only log app-API (githaiku.com) errors and
  // node 5xx — the signal we care about when diagnosing a failed run.
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (status < 400) return;
    const isAppApi = url.includes("api.githaiku.com");
    const isNodeServerError = url.includes("node.tinycloud.xyz") && status >= 500;
    if (isAppApi || isNodeServerError) console.log(`[http ${status}] ${url}`);
  });

  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: TEST_ADDRESS,
    privateKey: TEST_PRIVATE_KEY,
    walletName: TEST_WALLET_NAME,
  });

  // First-time owner: auto-click the web-sdk "Create TinyCloud Space" modal
  // whenever it appears (the human-clicked space-creation step).
  autoCreateSpaceOnModal(page);

  // ── PART 1: land on the owner view and sign in via the external wallet ──────
  await page.goto("/owner");
  await signIn(page);

  // ── PART 2: route after sign-in ─────────────────────────────────────────────
  // A FRESH anvil-key owner has no backend record (getOwner → 404) and lands on
  // the SETUP form. A RETURNING owner (this same anvil key already registered in
  // a prior run) routes straight to the DASHBOARD. The test handles both: it
  // races the setup form against the dashboard's Preview button and only runs
  // setup when the form actually appears. Either path converges on the dashboard.
  const loginInput = firstVisible(
    page.getByTestId("setup-github-login"),
    page.getByPlaceholder("octocat"),
  );
  const tokenInput = firstVisible(
    page.getByTestId("setup-github-token"),
    page.getByPlaceholder("ghp_…"),
  );
  const previewButton = firstVisible(
    page.getByTestId("preview-run"),
    page.getByRole("button", { name: /preview \/ test haiku/i }),
  );

  // Wait for whichever view rendered after sign-in.
  await expect(loginInput.or(previewButton).first()).toBeVisible({ timeout: 120000 });

  const onSetup = await loginInput.isVisible();
  if (onSetup) {
    console.log("[flow] fresh owner → setup form");
    // ── PART 3: authorize → secrets.put + register + delegate → dashboard ─────
    await loginInput.fill(githubLogin);
    await tokenInput.fill(githubToken);
    const authorize = firstVisible(
      page.getByTestId("setup-authorize"),
      page.getByRole("button", { name: /authorize & generate code/i }),
    );

    // First-time owners provision their TinyCloud `secrets` space during this
    // step. The owned-space activation can lose a race with the just-created
    // space's propagation on the live node, surfacing as a transient
    // "Space not found" denial. A human simply clicks Authorize again; do the
    // same, bounded. The space, once created, persists — so a retry succeeds.
    const denial = page.locator(".denial");
    const spaceNotFound = denial.filter({ hasText: /space not found/i });
    for (let attempt = 1; attempt <= 4; attempt++) {
      await authorize.click();
      // Whichever resolves first: dashboard (success) or the space-not-found denial.
      await expect(previewButton.or(spaceNotFound).first()).toBeVisible({ timeout: 90000 });
      if (await previewButton.isVisible()) break;
      if (await spaceNotFound.isVisible()) {
        console.log(`[flow] space-not-found (attempt ${attempt}) — retrying authorize`);
        await page.waitForTimeout(3000);
        continue;
      }
    }
  } else {
    console.log("[flow] returning owner → dashboard (setup skipped)");
  }

  // Dashboard arrival: the Preview card is present in both paths.
  await expect(previewButton).toBeVisible({ timeout: 180000 });

  // The signed-in address display should reflect the test wallet. The deployed
  // dashboard renders a shortened did:pkh ending in the last 8 of the address, so
  // match that suffix when the testid isn't present yet.
  const addressDisplay = firstVisible(
    page.getByTestId("owner-address"),
    page.getByText(ADDRESS_SUFFIX).first(),
  );
  await expect(addressDisplay).toBeVisible();

  // ── PART 4: run the preview → an allowed 3-line haiku ───────────────────────
  await previewButton.click();

  const haikuLines = firstVisible(
    page.getByTestId("haiku-line"),
    page.locator(".haiku .haiku-line"),
  );
  // Race the haiku against the preview's denial card so a backend failure (e.g. a
  // decrypt/secrets-stage error) fails FAST with the actionable on-page reason
  // instead of timing out generically. The denial card is the PreviewHaiku
  // component's stage-keyed message under the Preview button.
  const previewDenial = page
    .locator(".card", { has: previewButton })
    .locator(".denial");
  await expect(haikuLines.first().or(previewDenial)).toBeVisible({ timeout: 180000 });
  if (await previewDenial.isVisible()) {
    const reason = (await previewDenial.innerText()).trim();
    throw new Error(
      `Preview did not produce a haiku — backend denied at the preview stage: "${reason}". ` +
        `Check the backend logs (phala cvms logs <git-haiku-prod> -c dstack-githaiku-backend-1) ` +
        `for the precise stage/reason.`,
    );
  }
  await expect(haikuLines).toHaveCount(3);

  const lines = await haikuLines.allInnerTexts();
  console.log("─── generated haiku ───");
  for (const line of lines) console.log(line);
  console.log("───────────────────────");
  expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(3);

  // ── PART 5: the mock wallet actually signed (SIWE / delegation) ─────────────
  await expect
    .poll(() => page.evaluate(() => (window as any).__walletRequests))
    .toContain("personal_sign");
});
