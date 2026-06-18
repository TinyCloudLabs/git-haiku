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
 *  - tc-cli / TEE: persisted in the backend's OWN TinyCloud KV space under
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

/**
 * Derive a stable, non-reversible id for a code so the audit log can group
 * requests by code WITHOUT storing the code itself. sha256 -> first 16 hex.
 */
export function codeIdFor(code: string): string {
  return createHash('sha256').update(`githaiku-audit:${code}`).digest('hex').slice(0, 16);
}

function useKv(): boolean {
  return config.secretsProvider === 'tc-cli';
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
