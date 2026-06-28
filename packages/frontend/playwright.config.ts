import { defineConfig, devices } from "@playwright/test";

/**
 * Git Haiku headless e2e — drives the REAL owner flow against the DEPLOYED app
 * (default https://githaiku.com, talking to the live backend api.githaiku.com)
 * using OpenKey's "external wallet" option backed by a mock browser wallet. No
 * local webServer: we run against the deployed site so this exercises the same
 * bits a human would. Override the target with GITHAIKU_E2E_BASE_URL.
 *
 * Ported from secret-manager's openkey-wallet-secret-flow harness (the blessed
 * reference), adapted to pnpm + git-haiku's owner flow.
 */
const BASE_URL = process.env.GITHAIKU_E2E_BASE_URL ?? "https://githaiku.com";

export default defineConfig({
  testDir: "e2e/specs",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  expect: {
    // The full owner flow does several SIWE/personal_sign round-trips plus live
    // GitHub + generation calls; give each assertion room.
    timeout: 90000,
  },
  // Whole-test budget: sign-in + setup (secrets.put + register + delegate) +
  // a live preview that fetches GitHub and generates a haiku.
  timeout: 300000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
