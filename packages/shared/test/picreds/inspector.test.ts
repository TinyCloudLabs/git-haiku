import { describe, expect, it } from 'vitest';

import { inspectGeneration } from '../../src/picreds';

const NOW = new Date('2026-06-20T00:00:00Z');

function commit(overrides: Partial<{ repo: string; message: string; timestamp: string }> = {}) {
  return {
    repo: 'githaiku',
    message: 'feat: wire the picreds inspector',
    timestamp: '2026-06-18T09:00:00Z',
    ...overrides,
  };
}

const HAIKU = ['old branches whisper', 'commit lanterns light the path', 'spring merges quietly'];

describe('inspectGeneration', () => {
  it('passes all four checks for well-formed input', () => {
    const report = inspectGeneration({
      commits: [commit()],
      haikuLines: HAIKU,
      maxCommits: 30,
      windowDays: 30,
      now: NOW,
    });
    expect(report).toEqual({
      scope_ok: true,
      cap_ok: true,
      leak_ok: true,
      egress_ok: true,
      checks: {
        scope: { pass: true, reason: expect.any(String) },
        cap: { pass: true, reason: expect.any(String) },
        leak: { pass: true, reason: expect.any(String) },
        egress: { pass: true, reason: expect.any(String) },
      },
    });
  });

  describe('scope check', () => {
    it('fails when a commit carries a diff/patch/files key', () => {
      const withDiff = { ...commit(), diff: '+++ hidden change' };
      const report = inspectGeneration({
        commits: [withDiff],
        haikuLines: HAIKU,
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.scope_ok).toBe(false);
      expect(report.checks.scope.reason).toContain('diff');
      // Other checks still evaluate independently.
      expect(report.cap_ok).toBe(true);
    });

    it('fails when a commit entry is not a plain object', () => {
      const report = inspectGeneration({
        commits: ['not-an-object'],
        haikuLines: HAIKU,
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.scope_ok).toBe(false);
    });
  });

  describe('cap check', () => {
    it('fails when commit count exceeds maxCommits', () => {
      const commits = Array.from({ length: 5 }, () => commit());
      const report = inspectGeneration({
        commits,
        haikuLines: HAIKU,
        maxCommits: 3,
        windowDays: 30,
        now: NOW,
      });
      expect(report.cap_ok).toBe(false);
      expect(report.checks.cap.reason).toContain('exceeds the cap');
    });

    it('fails when a commit timestamp falls outside the window', () => {
      const report = inspectGeneration({
        commits: [commit({ timestamp: '2025-01-01T00:00:00Z' })],
        haikuLines: HAIKU,
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.cap_ok).toBe(false);
      expect(report.checks.cap.reason).toContain('window');
    });

    it('fails when a commit is missing a string timestamp', () => {
      const report = inspectGeneration({
        commits: [{ repo: 'githaiku', message: 'x' }],
        haikuLines: HAIKU,
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.cap_ok).toBe(false);
    });
  });

  describe('leak check', () => {
    it('fails when a long commit-message token appears verbatim in the haiku', () => {
      const leaky = commit({ message: 'fix: rotate AKIAABCDEFGHIJKLMNOP credential' });
      const report = inspectGeneration({
        commits: [leaky],
        haikuLines: ['old branches whisper', 'AKIAABCDEFGHIJKLMNOP leaked here', 'spring merges quietly'],
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.leak_ok).toBe(false);
      // The reason never repeats the leaked token itself.
      expect(report.checks.leak.reason).not.toContain('AKIA');
    });

    it('is case-insensitive', () => {
      const leaky = commit({ message: 'chore: bump SOMELONGTOKEN1234 in config' });
      const report = inspectGeneration({
        commits: [leaky],
        haikuLines: ['old branches whisper', 'somelongtoken1234 rests quiet', 'spring merges quietly'],
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.leak_ok).toBe(false);
    });

    it('passes for short tokens under leakMinLength (not treated as a leak)', () => {
      const report = inspectGeneration({
        commits: [commit({ message: 'fix: bug' })],
        haikuLines: ['old bug whispers', 'commit lanterns light the path', 'spring merges quietly'],
        maxCommits: 30,
        windowDays: 30,
        leakMinLength: 8,
        now: NOW,
      });
      expect(report.leak_ok).toBe(true);
    });
  });

  describe('egress check', () => {
    it('fails when the haiku is not exactly three lines', () => {
      const report = inspectGeneration({
        commits: [commit()],
        haikuLines: ['only', 'two'],
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.egress_ok).toBe(false);
    });

    it('fails when a line is empty', () => {
      const report = inspectGeneration({
        commits: [commit()],
        haikuLines: ['old branches whisper', '   ', 'spring merges quietly'],
        maxCommits: 30,
        windowDays: 30,
        now: NOW,
      });
      expect(report.egress_ok).toBe(false);
    });
  });
});
