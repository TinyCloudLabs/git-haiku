import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the owner sign-in lifecycle (aligned to listen's TinyCloudWeb pattern).
 *
 * Two live bugs this locks down:
 *
 * 1. "TinyCloud hosts have not been resolved. Call signIn() first." — the
 *    web-sdk's `signIn()` begins with an internal `restoreSession()` and, when
 *    BrowserSessionStorage holds a session, returns it WITHOUT running the wallet
 *    flow that resolves hosts. A restored session leaves `tinycloudHosts` empty,
 *    so the next `ensureOwnedSpaceHosted('secrets')` throws. The fix: always pass
 *    a concrete `tinycloudHosts`, and clear any stale persisted session BEFORE
 *    `signIn()` so the full wallet flow runs.
 *
 * 2. secrets.put's escalation/requestPermissions path needs the app manifest
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

  it('createAndSignIn always configures tinycloudHosts (hosts present on every path)', async () => {
    await createAndSignIn({} as never, composed, OWNER);
    const cfg = ctorConfigs.at(-1)!;
    const hosts = cfg.tinycloudHosts as string[] | undefined;
    expect(Array.isArray(hosts)).toBe(true);
    expect(hosts!.length).toBeGreaterThan(0);
    expect(hosts![0]).toMatch(/^https?:\/\//);
  });

  it('createAndSignIn clears the stale persisted session BEFORE signIn (so the wallet flow resolves hosts)', async () => {
    await createAndSignIn({} as never, composed, OWNER);
    expect(clearPersistedSession).toHaveBeenCalledWith(OWNER);
    // Ordering is the invariant: a service-bearing signIn must not be preceded
    // by an internal restore short-circuit. Clearing first guarantees the full
    // wallet flow runs, which is what resolves hosts.
    expect(callOrder).toEqual(['clearPersistedSession', 'signIn']);
  });

  it('restoreSession passes the manifest too (secrets.put runs on restored sessions)', async () => {
    await restore(OWNER);
    const cfg = ctorConfigs.at(-1)!;
    const manifest = cfg.manifest as { app_id?: string } | undefined;
    expect(manifest?.app_id).toBe('com.githaiku');
  });

  it('restoreSession always configures tinycloudHosts (restored session can use services)', async () => {
    await restore(OWNER);
    const cfg = ctorConfigs.at(-1)!;
    const hosts = cfg.tinycloudHosts as string[] | undefined;
    expect(Array.isArray(hosts)).toBe(true);
    expect(hosts!.length).toBeGreaterThan(0);
  });
});
