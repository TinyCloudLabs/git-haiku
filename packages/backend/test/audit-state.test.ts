import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-audit-state-test-'));
process.env.GITHAIKU_SECRETS_PROVIDER = 'local';
process.env.GITHAIKU_INVALID_AUDIT_WINDOW_MS = '1000';
process.env.GITHAIKU_INVALID_AUDIT_MAX_WINDOWS = '3';

const { getInvalidAuditCoalescingStateForTests, recordInvalidCodeAudit, resetAuditCoalescing } = await import(
  '../src/audit'
);

beforeEach(() => {
  resetAuditCoalescing();
});

describe('invalid-code audit coalescing state', () => {
  it('evicts expired invalid-audit windows on access', async () => {
    await recordInvalidCodeAudit({ ip: '203.0.113.10', at: new Date(0) });
    expect(getInvalidAuditCoalescingStateForTests()).toEqual({ windows: 1, maxWindows: 3 });

    await recordInvalidCodeAudit({ ip: '203.0.114.10', at: new Date(1000) });
    expect(getInvalidAuditCoalescingStateForTests()).toEqual({ windows: 1, maxWindows: 3 });
  });

  it('keeps invalid-audit coalescing state bounded under many distinct keys', async () => {
    for (let i = 0; i < 25; i++) {
      await recordInvalidCodeAudit({ ip: `198.51.${i}.10`, at: new Date(0) });
    }

    const state = getInvalidAuditCoalescingStateForTests();
    expect(state.maxWindows).toBe(3);
    expect(state.windows).toBeLessThanOrEqual(state.maxWindows);
  });
});
