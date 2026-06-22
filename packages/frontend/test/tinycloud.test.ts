import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the live owner bug: secrets.put's escalation/requestPermissions path
 * needs the app manifest STORED on the TinyCloudWeb instance. The real flow is
 * exercised in a browser (OpenKey + WASM); here we mock the web-sdk at the
 * import boundary and assert createAndSignIn / restoreSession pass `manifest`
 * (app_id 'com.githaiku') in the TinyCloudWeb config.
 */

const { ctorConfigs, signIn, restoreSession } = vi.hoisted(() => ({
  ctorConfigs: [] as Array<Record<string, unknown>>,
  signIn: vi.fn(async () => {}),
  restoreSession: vi.fn(async () => ({ status: 'none', session: null })),
}));

vi.mock('@tinycloud/web-sdk', () => ({
  TinyCloudWeb: class {
    constructor(cfg: Record<string, unknown>) {
      ctorConfigs.push(cfg);
    }
    signIn = signIn;
    restoreSession = restoreSession;
  },
  BrowserSessionStorage: class {},
  composeManifestRequest: vi.fn(),
  serializeDelegation: vi.fn(),
}));

import { createAndSignIn, restoreSession as restore } from '../src/lib/tinycloud';
import type { ComposedManifestRequest } from '@tinycloud/web-sdk';

afterEach(() => {
  ctorConfigs.length = 0;
  vi.clearAllMocks();
});

describe('TinyCloudWeb config carries the app manifest', () => {
  const composed = { delegationTargets: [] } as unknown as ComposedManifestRequest;

  it('createAndSignIn passes manifest (com.githaiku) alongside capabilityRequest', async () => {
    await createAndSignIn({} as never, composed);
    const cfg = ctorConfigs.at(-1)!;
    expect(cfg.capabilityRequest).toBe(composed);
    const manifest = cfg.manifest as { app_id?: string } | undefined;
    expect(manifest?.app_id).toBe('com.githaiku');
  });

  it('restoreSession passes the manifest too (secrets.put runs on restored sessions)', async () => {
    await restore('0xabc');
    const cfg = ctorConfigs.at(-1)!;
    const manifest = cfg.manifest as { app_id?: string } | undefined;
    expect(manifest?.app_id).toBe('com.githaiku');
  });
});
