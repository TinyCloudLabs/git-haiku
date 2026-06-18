import { describe, expect, it } from 'vitest';

import { composeOwnerRequest } from '../src/lib/tinycloud';
import { APP_MANIFEST } from '../src/lib/appManifest';
import type { ServerInfo } from '../src/api';

/**
 * Verifies the composed capability request the owner signs carries the backend's
 * delegation target with: KV-get on the GITHUB_TOKEN vault path, a decrypt grant
 * bound to the OWNER's default encryption network (decryptDelegateDid = backend
 * did), and a ~90d expiry. Uses the REAL sdk-core compose — no mocks.
 */

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
      path: 'vault/secrets/GITHUB_TOKEN',
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

  it('grants the owner app the valid secret write action needed by secrets.put', () => {
    expect(APP_MANIFEST.secrets?.GITHUB_TOKEN).toEqual(expect.arrayContaining(['read', 'write']));
  });

  it('produces a delegation target for the backend DID', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID);
    expect(target).toBeDefined();
  });

  it('the target carries a KV-get on the GITHUB_TOKEN vault path', () => {
    const target = composed.delegationTargets.find((t) => t.did === BACKEND_DID)!;
    const kv = target.permissions.find(
      (p) => p.service === 'tinycloud.kv' && p.path.includes('vault/secrets/GITHUB_TOKEN'),
    );
    expect(kv).toBeDefined();
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
});
