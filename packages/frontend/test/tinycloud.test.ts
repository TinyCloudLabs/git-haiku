import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the owner sign-in lifecycle (aligned to listen's TinyCloudWeb pattern).
 *
 * Invariants this locks down:
 *
 * 1. `tinycloudHosts` is OPTIONAL — left undefined unless VITE_TINYCLOUD_HOST is
 *    set as an explicit override. As of web-sdk 2.4.0-beta.11 the SDK resolves
 *    the node itself (registry → node.tinycloud.xyz) and a restored session
 *    rehydrates its own hosts, so no hardcoded host is needed. (The default test
 *    env sets no override, so the ctor receives `tinycloudHosts: undefined`.)
 *
 * 2. Owner setup clears any stale persisted session BEFORE `signIn()` so the
 *    full wallet flow signs the freshly composed recap (carrying the
 *    encryption-network + scoped-secret grants), not a stale one. Mirrors
 *    listen's pre-fresh-sign-in clear.
 *
 * 3. secrets.put's escalation/requestPermissions path needs the app manifest
 *    (`app_id: 'com.githaiku'`) STORED on the instance.
 *
 * The real flow is exercised in a browser (OpenKey + WASM); here we mock the
 * web-sdk at the import boundary and assert the construction + ordering.
 */

const { ctorConfigs, callOrder, signIn, restoreSession, clearPersistedSession } = vi.hoisted(
  () => ({
    ctorConfigs: [] as Array<Record<string, unknown>>,
    callOrder: [] as string[],
    signIn: vi.fn(async () => {
      callOrder.push('signIn');
    }),
    restoreSession: vi.fn(async () => ({ status: 'none', session: null })),
    clearPersistedSession: vi.fn(async () => {
      callOrder.push('clearPersistedSession');
    }),
  }),
);

vi.mock('@tinycloud/web-sdk', () => ({
  TinyCloudWeb: class {
    constructor(cfg: Record<string, unknown>) {
      ctorConfigs.push(cfg);
    }
    signIn = signIn;
    restoreSession = restoreSession;
    clearPersistedSession = clearPersistedSession;
  },
  BrowserSessionStorage: class {},
  composeManifestRequest: vi.fn(),
  serializeDelegation: vi.fn(),
}));

import { createAndSignIn, restoreSession as restore } from '../src/lib/tinycloud';
import type { ComposedManifestRequest } from '@tinycloud/web-sdk';

afterEach(() => {
  ctorConfigs.length = 0;
  callOrder.length = 0;
  vi.clearAllMocks();
});

describe('owner sign-in lifecycle (listen-aligned)', () => {
  const composed = { delegationTargets: [] } as unknown as ComposedManifestRequest;
  const OWNER = '0x1111111111111111111111111111111111111111';

  it('createAndSignIn passes manifest (com.githaiku) alongside capabilityRequest', async () => {
    await createAndSignIn({} as never, composed, OWNER);
    const cfg = ctorConfigs.at(-1)!;
    expect(cfg.capabilityRequest).toBe(composed);
    const manifest = cfg.manifest as { app_id?: string } | undefined;
    expect(manifest?.app_id).toBe('com.githaiku');
  });

  it('createAndSignIn leaves tinycloudHosts undefined when no override is set (SDK resolves the node)', async () => {
    await createAndSignIn({} as never, composed, OWNER);
    const cfg = ctorConfigs.at(-1)!;
    // No VITE_TINYCLOUD_HOST in the test env ⇒ optional hosts are undefined, so
    // the SDK resolves the node (registry → node.tinycloud.xyz fallback).
    expect(cfg.tinycloudHosts).toBeUndefined();
  });

  it('createAndSignIn clears the stale persisted session BEFORE signIn (so setup signs the fresh recap)', async () => {
    await createAndSignIn({} as never, composed, OWNER);
    expect(clearPersistedSession).toHaveBeenCalledWith(OWNER);
    // Ordering is the invariant: the owner-setup signIn must not be preceded by
    // an internal restore short-circuit. Clearing first guarantees the full
    // wallet flow runs and signs the freshly composed recap.
    expect(callOrder).toEqual(['clearPersistedSession', 'signIn']);
  });

  it('restoreSession passes the manifest too (secrets.put runs on restored sessions)', async () => {
    await restore(OWNER);
    const cfg = ctorConfigs.at(-1)!;
    const manifest = cfg.manifest as { app_id?: string } | undefined;
    expect(manifest?.app_id).toBe('com.githaiku');
  });

  it('restoreSession leaves tinycloudHosts undefined when no override is set (SDK rehydrates hosts)', async () => {
    await restore(OWNER);
    const cfg = ctorConfigs.at(-1)!;
    // web-sdk 2.4.0-beta.11 rehydrates a restored session's hosts, so no
    // hardcoded host is needed for service calls to work.
    expect(cfg.tinycloudHosts).toBeUndefined();
  });
});
