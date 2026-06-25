import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from './config';
import { getBackendIdentity, withSessionRefresh } from './identity';

/**
 * Append-only audit log of haiku requests (spec requirement).
 *
 * Each entry records ONLY: a derived requester code id (a hash prefix — NEVER
 * the raw secret code), the owner id, an ISO timestamp, the allow/deny outcome,
 * the policy id, and a short machine reason. It NEVER stores secret values,
 * GitHub tokens, commit messages, or any raw commit data — the same egress
 * discipline as the haiku response itself.
 *
 *  - sdk / TEE: persisted in the backend's OWN TinyCloud KV space under
 *    `audit/<ownerId>/<timestamp>-<rand>` so each entry is an immutable key
 *    (append-only; we never overwrite or delete). Lifted from listen's KV usage.
 *  - local (dev): appended to a gitignored JSONL file under config.dataDir.
 */

export type AuditDecision = 'allow' | 'deny';

export interface AuditEntry {
  /** Stable, non-reversible id for the presented code (sha256 prefix). */
  codeId: string;
  /** The owner whose haiku was requested (null when no code matched). */
  ownerId: string | null;
  ts: string;
  decision: AuditDecision;
  /** Machine reason / policy decision — never secret or commit data. */
  reason: string;
  policyId: string;
}

const KV_PREFIX = 'audit/';
const FILE_PATH = join(config.dataDir, 'audit.log.jsonl');
const INVALID_AUDIT_WINDOW_MS = Number(process.env['GITHAIKU_INVALID_AUDIT_WINDOW_MS'] ?? 60_000);
const INVALID_AUDIT_MAX_WINDOWS = parsePositiveInt(process.env['GITHAIKU_INVALID_AUDIT_MAX_WINDOWS'], 20_000);
const invalidAuditWindows = new Map<string, number>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

/**
 * Derive a stable, non-reversible id for a code so the audit log can group
 * requests by code WITHOUT storing the code itself. sha256 -> first 16 hex.
 */
export function codeIdFor(code: string): string {
  return createHash('sha256').update(`githaiku-audit:${code}`).digest('hex').slice(0, 16);
}

function coarseIp(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return ip.split('.').slice(0, 3).join('.') + '.0/24';
  }
  const parts = ip.split(':');
  if (parts.length > 2) {
    return parts.slice(0, 4).join(':') + '::/64';
  }
  return ip;
}

export function invalidAuditCodeId(ip: string, at = new Date()): string {
  const windowStart = Math.floor(at.getTime() / INVALID_AUDIT_WINDOW_MS) * INVALID_AUDIT_WINDOW_MS;
  const digest = createHash('sha256')
    .update(`githaiku-invalid-audit:${coarseIp(ip)}:${windowStart}`)
    .digest('hex')
    .slice(0, 16);
  return `invalid:${digest}`;
}

function sweepInvalidAuditWindows(now: number): void {
  for (const [key, expiresAt] of invalidAuditWindows) {
    if (expiresAt <= now) {
      invalidAuditWindows.delete(key);
    }
  }
}

function enforceInvalidAuditWindowCap(): void {
  while (invalidAuditWindows.size > INVALID_AUDIT_MAX_WINDOWS) {
    const oldest = invalidAuditWindows.keys().next().value;
    if (oldest === undefined) return;
    invalidAuditWindows.delete(oldest);
  }
}

function rememberInvalidAuditWindow(key: string, expiresAt: number): void {
  invalidAuditWindows.delete(key);
  invalidAuditWindows.set(key, expiresAt);
  enforceInvalidAuditWindowCap();
}

function useKv(): boolean {
  return config.secretsProvider === 'sdk';
}

/** Defensive: ensure no obvious secret/commit fields ever land in an entry. */
function assertCleanEntry(entry: AuditEntry): void {
  const forbidden = ['githubToken', 'token', 'secret', 'commit', 'message', 'serialized', 'code'];
  for (const key of Object.keys(entry)) {
    if (forbidden.includes(key)) {
      throw new Error(`audit entry contains forbidden field: ${key}`);
    }
  }
}

function append(entry: AuditEntry): void {
  mkdirSync(dirname(FILE_PATH), { recursive: true });
  appendFileSync(FILE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function recordEntry(entry: AuditEntry): Promise<void> {
  assertCleanEntry(entry);

  if (!useKv()) {
    append(entry);
    return;
  }
  const { node } = await getBackendIdentity();
  // Immutable key per entry => append-only (never overwrite/delete).
  const owner = entry.ownerId ?? 'unknown';
  const key = `${KV_PREFIX}${owner}/${entry.ts}-${Math.random().toString(36).slice(2, 10)}`;
  await withSessionRefresh(node, () => node.kv.put(key, entry));
}

function readFile(ownerId: string): AuditEntry[] {
  if (!existsSync(FILE_PATH)) return [];
  return readFileSync(FILE_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEntry)
    .filter((e) => e.ownerId === ownerId);
}

/** Record one audit entry. Append-only; failures never block the request path
 *  caller, which decides whether to await. */
export async function recordAudit(input: {
  code: string;
  ownerId: string | null;
  decision: AuditDecision;
  reason: string;
}): Promise<void> {
  const entry: AuditEntry = {
    codeId: codeIdFor(input.code),
    ownerId: input.ownerId,
    ts: new Date().toISOString(),
    decision: input.decision,
    reason: input.reason,
    policyId: 'secret-code-v1',
  };
  await recordEntry(entry);
}

export async function recordInvalidCodeAudit(input: { ip: string; at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  const atMs = at.getTime();
  const codeId = invalidAuditCodeId(input.ip, at);
  const windowStart = Math.floor(atMs / INVALID_AUDIT_WINDOW_MS) * INVALID_AUDIT_WINDOW_MS;
  const windowKey = `${codeId}:${Math.floor(atMs / INVALID_AUDIT_WINDOW_MS)}`;
  sweepInvalidAuditWindows(atMs);
  if (invalidAuditWindows.has(windowKey)) {
    rememberInvalidAuditWindow(windowKey, windowStart + INVALID_AUDIT_WINDOW_MS);
    return;
  }
  rememberInvalidAuditWindow(windowKey, windowStart + INVALID_AUDIT_WINDOW_MS);

  await recordEntry({
    codeId,
    ownerId: null,
    ts: at.toISOString(),
    decision: 'deny',
    reason: 'invalid_code',
    policyId: 'secret-code-v1',
  });
}

/** Read an owner's audit trail (newest first). */
export async function readAudit(ownerId: string): Promise<AuditEntry[]> {
  if (!useKv()) {
    return readFile(ownerId).sort((a, b) => b.ts.localeCompare(a.ts));
  }
  const { node } = await getBackendIdentity();
  const listed = await withSessionRefresh(node, () =>
    node.kv.list({ prefix: `${KV_PREFIX}${ownerId}`, removePrefix: false }),
  );
  const keys = extractKeys(listed);
  const entries: AuditEntry[] = [];
  for (const key of keys) {
    const got = await withSessionRefresh(node, () => node.kv.get(key));
    const raw = (got as { data?: unknown })?.data ?? got;
    const parsed = parseEntry(raw);
    if (parsed) entries.push(parsed);
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}

function extractKeys(listed: unknown): string[] {
  // KV list returns { ok, data: { keys: string[] } }.
  const data = (listed as { data?: { keys?: unknown } })?.data;
  const keys = data?.keys;
  if (Array.isArray(keys)) {
    return keys.filter((k): k is string => typeof k === 'string');
  }
  return [];
}

function parseEntry(raw: unknown): AuditEntry | null {
  let value: unknown = raw;
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
    value = (value as { data: unknown }).data;
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && typeof (value as AuditEntry).ts === 'string') {
    return value as AuditEntry;
  }
  return null;
}

/** Reset invalid-attempt coalescing state (tests only). */
export function resetAuditCoalescing(): void {
  invalidAuditWindows.clear();
}

/** Snapshot invalid-audit coalescing state (tests only). */
export function getInvalidAuditCoalescingStateForTests(): { windows: number; maxWindows: number } {
  return { windows: invalidAuditWindows.size, maxWindows: INVALID_AUDIT_MAX_WINDOWS };
}
