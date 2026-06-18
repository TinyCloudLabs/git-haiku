/**
 * LIVE end-to-end integration for the tc-cli delegated-secrets path.
 *
 * GATED: only runs with GITHAIKU_LIVE=1 (never in the default headless test
 * run). NOT mocked — stands up a real local tinycloud-node, uses a real OWNER
 * identity to put GITHUB_TOKEN (the owner's only delegated secret), delegates
 * KV-get + decrypt to the BACKEND's stable did:pkh (audience = pkh, the proven
 * fix), delivers the delegation to the backend (POST /api/delegations), and
 * triggers the haiku flow so the backend reads GITHUB_TOKEN via the REAL `tc`
 * CLI. The RedPill LLM key is backend config, NOT an owner secret.
 *
 *   GITHAIKU_LIVE=1 pnpm --filter @githaiku/backend tsx test/live-delegated-secrets.ts
 *
 * Env:
 *   GITHAIKU_NODE_BIN   path to the prebuilt tinycloud binary (default: the
 *                       tinycloud-dev checkout debug build)
 *   GITHAIKU_LIVE_PORT  local node port (default 8799)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializeDelegation,
  TinyCloudNode,
} from '@tinycloud/node-sdk';

const NODE_BIN =
  process.env['GITHAIKU_NODE_BIN'] ??
  '/Users/samgbafa/Documents/github/tinycloud-dev/repositories/tinycloud-node/target/debug/tinycloud';
const PORT = Number(process.env['GITHAIKU_LIVE_PORT'] ?? 8799);
const NODE_HOST = `http://127.0.0.1:${PORT}`;

// Throwaway, well-known anvil keys — local node only, never production.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BACKEND_KEY = '0x8b3a350cf5c34c9194ca3a545d9f2bc5b642b3ee6cca3a637f1d2d1765f37c13';
const NODE_SECRET = 'dGlueWNsb3VkLWdpdGhhaWt1LWxpdmUtc3RhdGljLXNlY3JldC0zMjBi';

// The owner's only delegated secret. GITHUB_TOKEN defaults to a fixture (proves
// the delegated read; a fixture token 401s at GitHub so the haiku path yields a
// guarded denial). Set GITHAIKU_LIVE_GITHUB_TOKEN to a real read-only token to
// also drive a real commit fetch -> rendered haiku.
const GITHUB_TOKEN =
  process.env['GITHAIKU_LIVE_GITHUB_TOKEN'] ?? 'ghp_live_fixture_0123456789abcdefABCDEF';
const GITHUB_LOGIN = process.env['GITHAIKU_LIVE_GITHUB_LOGIN'] ?? 'octocat';

function log(msg: string): void {
  process.stdout.write(`[live] ${msg}\n`);
}

async function waitForVersion(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${NODE_HOST}/version`);
      if (res.ok || res.status < 500) {
        log(`node /version: ${await res.text()}`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tinycloud node did not become ready at ${NODE_HOST}/version`);
}

function startNode(dataDir: string): ChildProcess {
  const tomlPath = join(dataDir, 'tinycloud.toml');
  writeFileSync(
    tomlPath,
    [
      '[global.keys]',
      'type = "Static"',
      `secret = "${NODE_SECRET}"`,
      '',
    ].join('\n'),
    'utf8',
  );
  const child = spawn(NODE_BIN, [], {
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
  return child;
}

async function main(): Promise<void> {
  if (process.env['GITHAIKU_LIVE'] !== '1') {
    process.stderr.write('[skip] set GITHAIKU_LIVE=1 to run the live delegated-secrets test.\n');
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'githaiku-live-node-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'githaiku-live-app-'));
  let node: ChildProcess | null = null;

  // The backend identity, store, and provider all read config from env. Point
  // them at the local node + backend key + a fresh app data dir BEFORE importing
  // the backend modules (config is read at import time).
  process.env['GITHAIKU_SECRETS_PROVIDER'] = 'tc-cli';
  process.env['GITHAIKU_NODE_HOST'] = NODE_HOST;
  process.env['GITHAIKU_BACKEND_PRIVATE_KEY'] = BACKEND_KEY;
  process.env['GITHAIKU_DATA_DIR'] = appDataDir;
  // This live test proves the GITHUB_TOKEN delegation path, not LLM generation.
  // Force the deterministic generator so it never makes a live RedPill call.
  process.env['GITHAIKU_HAIKU_GENERATOR'] = 'deterministic';

  try {
    log(`starting node (bin=${NODE_BIN}, port=${PORT})`);
    node = startNode(dataDir);
    await waitForVersion();

    // --- Backend identity (stable did:pkh) -------------------------------
    const { getBackendIdentity } = await import('../src/identity');
    const backend = await getBackendIdentity();
    log(`backend did (delegation audience): ${backend.did}`);

    // --- Owner: put both secrets, delegate to the backend pkh ------------
    const owner = new TinyCloudNode({
      privateKey: OWNER_KEY,
      host: NODE_HOST,
      autoCreateSpace: true,
    });
    await owner.signIn();
    log(`owner did: ${owner.did}`);

    const network = await owner.ensureEncryptionNetwork('default');
    log(`owner encryption network: ${network.networkId}`);

    {
      const put = await owner.secrets.put('GITHUB_TOKEN', GITHUB_TOKEN);
      if (!put.ok) {
        throw new Error(`owner secrets.put(GITHUB_TOKEN) failed: ${put.error.code} ${put.error.message}`);
      }
      log('owner put secret GITHUB_TOKEN');
    }

    // One multi-resource delegation: KV-get on GITHUB_TOKEN + decrypt. Audience
    // is the backend's STABLE did:pkh (the proven fix). node-sdk 2.3.1-beta.0
    // activates this multi-resource delegation correctly.
    const delegation = await owner.delegateTo(backend.did, [
      {
        service: 'tinycloud.kv',
        space: 'secrets',
        path: 'vault/secrets/GITHUB_TOKEN',
        actions: ['tinycloud.kv/get'],
      },
      {
        service: 'tinycloud.encryption',
        path: network.networkId,
        actions: ['tinycloud.encryption/decrypt'],
      },
    ]);
    const serialized = serializeDelegation(delegation.delegation);
    log(`owner delegated to backend (cid=${delegation.delegation.cid})`);

    // --- Backend server: create owner, deliver delegation, run haiku -----
    const { buildServer } = await import('../src/server');
    const { createOwner } = await import('../src/store');
    const app = buildServer();
    await app.ready();

    const ownerAddress = owner.did.split(':').at(-1)!;
    const created = createOwner({ githubLogin: GITHUB_LOGIN });
    log(`backend owner created: ${created.ownerId}`);

    // server-info advertises the policy + backend did.
    const info = await app.inject({ method: 'GET', url: '/api/server-info' });
    log(`server-info: ${info.body}`);

    // POST the delegation.
    const delRes = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      payload: { ownerId: created.ownerId, ownerAddress, serialized },
    });
    if (delRes.statusCode !== 201) {
      throw new Error(`POST /api/delegations failed: ${delRes.statusCode} ${delRes.body}`);
    }
    log(`delegation accepted: ${delRes.body}`);

    // Directly exercise the tc-cli provider so we PROVE GITHUB_TOKEN was read
    // via the real `tc` binary under the delegation.
    const { makeSecretsProvider } = await import('../src/secrets');
    const { findOwnerById } = await import('../src/store');
    const provider = makeSecretsProvider();
    if (provider.kind !== 'tc-cli') throw new Error(`expected tc-cli provider, got ${provider.kind}`);
    const ownerRecord = findOwnerById(created.ownerId)!;
    const read = await provider.getOwnerSecrets(ownerRecord);

    if (read.githubToken !== GITHUB_TOKEN) {
      throw new Error(`GITHUB_TOKEN mismatch: got ${JSON.stringify(read.githubToken)}`);
    }
    log('PROVED: backend read GITHUB_TOKEN via the real tc CLI under the delegation.');

    // Trigger the guarded haiku flow end-to-end through the real /api/haiku
    // endpoint. With a fixture GITHUB_TOKEN the GitHub fetch 401s -> guarded
    // denial (no commit data leaks), which is correct egress behavior. With a
    // real GITHAIKU_LIVE_GITHUB_TOKEN it renders a 3-line haiku.
    const haiku = await app.inject({
      method: 'POST',
      url: '/api/haiku',
      payload: { code: created.secretCode },
    });
    const body = JSON.parse(haiku.body) as Record<string, unknown>;
    log(`/api/haiku response: ${haiku.body}`);
    if (body['allowed'] === true) {
      const lines = (body['haiku'] as { lines?: unknown }).lines;
      if (!Array.isArray(lines) || lines.length !== 3) {
        throw new Error('haiku response was allowed but not a guarded 3-line haiku');
      }
      log('PROVED: real /api/haiku produced a guarded 3-line haiku.');
    } else if (body['allowed'] === false) {
      log(`guarded denial (no commit data leaked): ${JSON.stringify(body)}`);
    } else {
      throw new Error('haiku response was neither allowed nor a clean denial');
    }

    // Independently exercise the haiku core over commit fixtures and through the
    // egress guard so the live run always captures a rendered, guarded haiku
    // (proves the secrets-read -> generate -> guard pipeline shape end to end).
    const { fetchRecentCommits } = await import('../src/github');
    const { makeHaikuGenerator } = await import('../src/haiku');
    const { guardOutboundPayload } = await import('@githaiku/shared');
    const { devProof } = await import('../src/proof');
    const { commits } = await fetchRecentCommits({ githubLogin: GITHUB_LOGIN, githubToken: null });
    const lines = await makeHaikuGenerator().generate(commits);
    const guarded = guardOutboundPayload({ allowed: true, haiku: { lines }, proof: devProof() });
    log(`rendered guarded haiku: ${JSON.stringify(guarded)}`);
    if (!('haiku' in guarded) || guarded.haiku.lines.length !== 3) {
      throw new Error('rendered haiku was not a guarded 3-line haiku');
    }
    log('PROVED: guarded 3-line haiku rendered through the egress guard.');

    await app.close();
    log('LIVE TEST PASSED');
  } finally {
    if (node && node.pid) {
      try {
        process.kill(node.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(appDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
