import { describe, expect, it } from 'vitest';

import { composeOwnerRequest } from '../src/lib/tinycloud';
import { APP_MANIFEST } from '../src/lib/appManifest';
import type { ServerInfo } from '../src/api';

/**
 * Verifies the composed capability request the owner signs carries the backend's
 * delegation target with: KV-get on the SCOPED GITHUB_TOKEN vault path
 * (vault/secrets/scoped/githaiku/GITHUB_TOKEN), a decrypt grant bound to the
 * OWNER's default encryption network (decryptDelegateDid = backend did), and a
 * ~90d expiry. Uses the REAL sdk-core compose — no mocks.
 */

// The scoped vault path the manifest resolves to + the backend advertises.
const GITHUB_TOKEN_VAULT_PATH = 'vault/secrets/scoped/githaiku/GITHUB_TOKEN';

const OWNER_DID = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const BACKEND_DID = 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222';

// Mirrors GET /api/server-info under tc-cli (packages/backend/src/policy.ts).
const SERVER_INFO: ServerInfo = {
  did: BACKEND_DID,
  name: 'Git Haiku Backend',
  permissions: [
    {
      service: 'tinycloud.kv',
      space: 'secrets',
      path: GITHUB_TOKEN_VAULT_PATH,
      actions: ['get'],
      skipPrefix: true,
    },
    {
      service: 'tinycloud.encryption',
      space: 'encryption',
      path: 'urn:tinycloud:encryption:<ownerDid>:default',
      actions: ['decrypt'],
      skipPrefix: true,
    },
  ],
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

describe('composeOwnerRequest', () => {
  const composed = composeOwnerRequest(SERVER_INFO, OWNER_DID);

  it('uses the com.githaiku reverse-DNS app_id', () => {
    expect(APP_MANIFEST.app_id).toBe('com.githaiku');
  });

  it('grants the owner app the valid secret write action needed by secrets.put, under the githaiku scope', () => {
    expect(APP_MANIFEST.secrets?.GITHUB_TOKEN).toEqual({
      actions: expect.arrayContaining(['read', 'write']),
      scope: 'githaiku',
    });
  });

  it('produces a delegation target for the backend DID', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID);
    expect(target).toBeDefined();
  });

  it('the target carries a KV-get on the SCOPED GITHUB_TOKEN vault path', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID)!;
    const kv = target.permissions.find(
      (p) => p.service === 'tinycloud.kv' && p.path.includes(GITHUB_TOKEN_VAULT_PATH),
    );
    expect(kv).toBeDefined();
    // Provably the scoped path — never the unscoped global path.
    expect(kv!.path).not.toMatch(/vault\/secrets\/GITHUB_TOKEN$/);
    expect(kv!.actions.map(String).join(',')).toContain('get');
    expect(kv!.actions.map(String).join(',')).not.toContain('put');
    expect(kv!.actions.map(String).join(',')).not.toContain('create');
  });

  it('the target carries a decrypt bound to the OWNER default encryption network', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID)!;
    const dec = target.permissions.find((p) => p.service === 'tinycloud.encryption');
    expect(dec).toBeDefined();
    // The <ownerDid> template must be resolved to the real owner DID.
    expect(dec!.path).toContain(OWNER_DID);
    expect(dec!.path).not.toContain('<ownerDid>');
    expect(dec!.actions.map(String).join(',')).toContain('decrypt');
  });

  it('uses a ~90 day expiry', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID)!;
    // sdk-core DEFAULT_EXPIRY is 90d; assert the target expiry is in that ballpark.
    expect(target.expiryMs).toBeGreaterThanOrEqual(NINETY_DAYS_MS - 2 * 24 * 60 * 60 * 1000);
    expect(target.expiryMs).toBeLessThanOrEqual(NINETY_DAYS_MS + 2 * 24 * 60 * 60 * 1000);
  });

  // ── OWNER recap (composed.resources) — what the owner's session signs ──
  // The delegationTargets above are the BACKEND's subset. These assertions
  // cover the OWNER's own grants (the recap that secrets.put is checked
  // against), which the browser-recap bug exposed as the real gap.

  it('grants the owner kv/get + kv/put on the SCOPED GITHUB_TOKEN vault path', () => {
    const kv = composed.resources.find(
      (r) => r.service === 'tinycloud.kv' && r.path === GITHUB_TOKEN_VAULT_PATH,
    );
    expect(kv).toBeDefined();
    const actions = kv!.actions.map(String);
    expect(actions).toContain('tinycloud.kv/get');
    expect(actions).toContain('tinycloud.kv/put');
  });

  it("grants the owner network.create + decrypt on their OWN default encryption network", () => {
    const enc = composed.resources.find(
      (r) =>
        r.service === 'tinycloud.encryption' &&
        r.path === `urn:tinycloud:encryption:${OWNER_DID}:default`,
    );
    expect(enc).toBeDefined();
    const actions = enc!.actions.map(String);
    // network.create: first-time lazy creation. decrypt: seal/open the envelope.
    expect(actions).toContain('tinycloud.encryption/network.create');
    expect(actions).toContain('tinycloud.encryption/decrypt');
  });

  it("keeps the backend delegation a strict SUBSET (no put, no network.create)", () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID)!;
    const allActions = target.permissions.flatMap((p) => p.actions.map(String));
    expect(allActions).not.toContain('tinycloud.kv/put');
    expect(allActions).not.toContain('tinycloud.encryption/network.create');
    expect(allActions).toContain('tinycloud.kv/get');
    expect(allActions).toContain('tinycloud.encryption/decrypt');
  });
});
