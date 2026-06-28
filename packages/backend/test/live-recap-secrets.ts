/**
 * LIVE recap-limited owner secrets test.
 *
 * GATED: only runs with GITHAIKU_LIVE=1.
 *
 * This is the test the original live-delegated-secrets.ts could NOT be: it signs
 * the owner in with a MANIFEST RECAP (capabilityRequest + manifest) — exactly
 * what the browser web-sdk does — instead of full node-sdk owner authority. A
 * recap session is limited to the capabilities the composed manifest expands to,
 * so it is the only way to catch grants that the manifest fails to confer.
 *
 * It reproduces the composed request the frontend builds in
 * `packages/frontend/src/lib/tinycloud.ts:composeOwnerRequest` (APP_MANIFEST +
 * the owner's encryption grant + the backend delegate manifest) and asserts that
 * under the recap the owner can:
 *   1. ensureEncryptionNetwork('default')  (needs encryption/network.create)
 *   2. secrets.put('GITHUB_TOKEN', …, { scope: 'githaiku' })  (needs kv/put on
 *      vault/secrets/scoped/githaiku/GITHUB_TOKEN + encryption/decrypt)
 *
 * NOTE on the secrets space: node-sdk/web-sdk only auto-host the owner's
 * `secrets` space at sign-in when NO manifest/capabilityRequest is supplied
 * (core: `manifest === void 0 && capabilityRequest === void 0`). A pure recap
 * session therefore never hosts it. To isolate the RECAP authorization (the bug
 * under test) from that separate SDK space-hosting gate, we pre-host the secrets
 * space once via a throwaway full-authority sign-in (a returning owner already
 * has it). The assertion that matters is that the recap session's put is
 * AUTHORIZED — not rejected with `Unauthorized Action … tinycloud.kv/put`.
 *
 *   GITHAIKU_LIVE=1 pnpm --filter @githaiku/backend tsx test/live-recap-secrets.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TinyCloudNode,
  composeManifestRequest,
  resolveSecretPath,
  type Manifest,
} from '@tinycloud/node-sdk';

import { GITHUB_TOKEN_SCOPE, backendPolicy, defaultEncryptionNetworkId } from '../src/policy';

const NODE_BIN =
  process.env['GITHAIKU_NODE_BIN'] ??
  '/Users/samgbafa/Documents/github/tinycloud-dev/repositories/tinycloud-node/target/debug/tinycloud';
const PORT = Number(process.env['GITHAIKU_LIVE_PORT'] ?? 8799);
const NODE_HOST = `http://127.0.0.1:${PORT}`;

// Throwaway, well-known anvil keys — local node only, never production.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BACKEND_KEY = '0x8b3a350cf5c34c9194ca3a545d9f2bc5b642b3ee6cca3a637f1d2d1765f37c13';
const NODE_SECRET = 'dGlueWNsb3VkLWdpdGhhaWt1LWxpdmUtc3RhdGljLXNlY3JldC0zMjBi';

const GITHUB_TOKEN = 'ghp_recap_fixture_0123456789abcdefABCDEF';

// Mirror packages/frontend/src/lib/appManifest.ts:APP_MANIFEST.
const APP_MANIFEST: Manifest = {
  manifest_version: 1,
  app_id: 'com.githaiku',
  name: 'Git Haiku',
  description: 'recap test',
  defaults: true,
  secrets: { GITHUB_TOKEN: { actions: ['read', 'write'], scope: GITHUB_TOKEN_SCOPE } },
  permissions: [],
};

const VAULT_PATH = resolveSecretPath('GITHUB_TOKEN', {
  scope: GITHUB_TOKEN_SCOPE,
}).permissionPaths.vault;

function log(msg: string): void {
  process.stdout.write(`[recap] ${msg}\n`);
}

async function waitForVersion(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${NODE_HOST}/version`);
      if (res.ok || res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tinycloud node did not become ready at ${NODE_HOST}/version`);
}

function startNode(dataDir: string): ChildProcess {
  writeFileSync(
    join(dataDir, 'tinycloud.toml'),
    ['[global.keys]', 'type = "Static"', `secret = "${NODE_SECRET}"`, ''].join('\n'),
    'utf8',
  );
  return spawn(NODE_BIN, [], {
    cwd: dataDir,
    env: {
      ...process.env,
      TINYCLOUD_LOG_LEVEL: 'normal',
      TINYCLOUD_PORT: String(PORT),
      TINYCLOUD_STORAGE_DATADIR: dataDir,
      TINYCLOUD_CORS: 'true',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * Rebuild the backend delegate manifest exactly as the frontend's
 * `backendManifestFromServerInfo` does (templated <ownerDid> resolved).
 */
function backendDelegateManifest(backendDid: string, ownerDid: string): Manifest {
  const policy = backendPolicy(ownerDid);
  return {
    manifest_version: 1,
    app_id: APP_MANIFEST.app_id,
    name: 'Git Haiku Backend',
    description: 'backend',
    did: backendDid,
    defaults: false,
    expiry: '90d',
    permissions: policy.map((p) => ({
      service: p.service,
      ...(p.space !== undefined ? { space: p.space } : {}),
      path: p.path,
      actions: [...p.actions],
      ...(p.skipPrefix !== undefined ? { skipPrefix: p.skipPrefix } : {}),
    })),
  };
}

async function main(): Promise<void> {
  if (process.env['GITHAIKU_LIVE'] !== '1') {
    process.stderr.write('[skip] set GITHAIKU_LIVE=1 to run the live recap-secrets test.\n');
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'githaiku-recap-node-'));
  let node: ChildProcess | null = null;
  try {
    log(`starting node (bin=${NODE_BIN}, port=${PORT})`);
    node = startNode(dataDir);
    await waitForVersion();

    const backend = new TinyCloudNode({ privateKey: BACKEND_KEY, host: NODE_HOST });
    await backend.signIn();
    const backendDid = backend.did;
    log(`backend did: ${backendDid}`);

    const { privateKeyToAccount } = await import('viem/accounts');
    const ownerAddress = privateKeyToAccount(OWNER_KEY as `0x${string}`).address;
    const ownerDid = `did:pkh:eip155:1:${ownerAddress}`;
    log(`owner did: ${ownerDid}`);

    // The composed request the FRONTEND signs: APP_MANIFEST + owner encryption
    // grant (create + decrypt) + the backend delegate manifest. This mirrors
    // composeOwnerRequest() — the owner encryption grant is THE FIX.
    const ownerAppManifest: Manifest = {
      ...APP_MANIFEST,
      permissions: [
        ...(APP_MANIFEST.permissions ?? []),
        {
          service: 'tinycloud.encryption',
          space: 'encryption',
          path: defaultEncryptionNetworkId(ownerDid),
          actions: ['tinycloud.encryption/network.create', 'tinycloud.encryption/decrypt'],
          skipPrefix: true,
        },
      ],
    };
    const composed = composeManifestRequest([
      ownerAppManifest,
      backendDelegateManifest(backendDid, ownerDid),
    ]);

    // Pre-host the owner's secrets space (returning owner already has it; a recap
    // session never hosts it — see header note). Isolates the recap AUTH check.
    {
      const full = new TinyCloudNode({ privateKey: OWNER_KEY, host: NODE_HOST, autoCreateSpace: true });
      await full.signIn();
      await full.ensureEncryptionNetwork('default');
      const seed = await full.secrets.put('SEED', 'x', { scope: GITHUB_TOKEN_SCOPE });
      if (!seed.ok) throw new Error(`pre-host secrets space failed: ${seed.error.code} ${seed.error.message}`);
      log('pre-hosted secrets space (returning owner)');
    }

    // RECAP-LIMITED session — exactly the browser's createAndSignIn config.
    const owner = new TinyCloudNode({
      privateKey: OWNER_KEY,
      host: NODE_HOST,
      autoCreateSpace: true,
      manifest: APP_MANIFEST,
      capabilityRequest: composed,
    });
    await owner.signIn();
    log('owner signed in with a manifest-RECAP session (not full authority)');

    // 1. The recap must authorize creating/using the owner's encryption network.
    const net = await owner.ensureEncryptionNetwork('default');
    log(`recap ensured encryption network: ${net.networkId}`);

    // 2. The recap must authorize the scoped kv/put (the exact bug from the
    //    browser: "Unauthorized Action … tinycloud.kv/put").
    const put = await owner.secrets.put('GITHUB_TOKEN', GITHUB_TOKEN, { scope: GITHUB_TOKEN_SCOPE });
    if (!put.ok) {
      throw new Error(
        `RECAP secrets.put(GITHUB_TOKEN) REJECTED (bug): ${put.error.code} ${put.error.message}`,
      );
    }
    log(`PROVED: recap-limited owner secrets.put SUCCEEDED on ${VAULT_PATH}`);

    // 3. The backend's delegation (get + decrypt) must remain a SUBSET of the
    //    owner's recap → the owner can mint it from the recap session WITHOUT a
    //    second wallet prompt (the session-key UCAN path). If the backend grant
    //    were not covered by the recap, delegateTo would throw
    //    PermissionNotInManifestError. (The full delegated decrypt-read pipeline
    //    is exercised separately by live-delegated-secrets.ts via the real tc
    //    CLI.)
    const delegation = await owner.delegateTo(backendDid, [
      { service: 'tinycloud.kv', space: 'secrets', path: VAULT_PATH, actions: ['tinycloud.kv/get'] },
      { service: 'tinycloud.encryption', path: net.networkId, actions: ['tinycloud.encryption/decrypt'] },
    ]);
    log(
      `PROVED: backend subset delegation minted from the recap, no extra prompt ` +
        `(cid=${delegation.delegation.cid})`,
    );

    log('LIVE RECAP TEST PASSED');
  } finally {
    if (node?.pid) {
      try {
        process.kill(node.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`[recap] FAILED: ${err?.stack ?? err}\n`);
  process.exit(1);
});
