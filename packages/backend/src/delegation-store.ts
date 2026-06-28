import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from './config';
import { getBackendIdentity, withSessionRefresh } from './identity';

/**
 * Per-owner delegation store.
 *
 * Persists the owner's serialized delegation so the sdk SecretsProvider can
 * read the owner's secrets under it. Keyed by ownerId.
 *
 *  - sdk / TEE: the backend's OWN TinyCloud KV space, key
 *    `delegations/<ownerId>` (lifted from listen
 *    `packages/server/src/delegation-store.ts`). Survives across TEE reboots and
 *    is bound to the backend's stable identity.
 *  - local (dev): a gitignored JSON file under config.dataDir, so the
 *    zero-infra preview keeps working.
 *
 * The stored `serialized` is the serialized PortableDelegation that the sdk
 * provider feeds to `node.useDelegation(...)`.
 */

export interface StoredDelegation {
  ownerId: string;
  /** The serialized delegation candidate JSON (what tc --delegation reads). */
  serialized: string;
  /** Owner did:pkh the delegation was granted from. */
  ownerDid: string;
  grantedAt: string;
  /** ISO expiry, if the delegation carried one. */
  expiresAt: string | null;
}

const KV_PREFIX = 'delegations/';

function kvKey(ownerId: string): string {
  if (!ownerId || ownerId.includes('/') || ownerId.includes('\\') || ownerId.includes('..')) {
    throw new Error('invalid delegation ownerId');
  }
  return `${KV_PREFIX}${ownerId}`;
}

// ── dev-local JSON backend ───────────────────────────────────────────

interface StoreFile {
  delegations: StoredDelegation[];
}

const STORE_PATH = join(config.dataDir, 'delegations.json');

function loadFile(): StoreFile {
  if (!existsSync(STORE_PATH)) return { delegations: [] };
  return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as StoreFile;
}

function persistFile(data: StoreFile): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function fileStore(): { put(r: StoredDelegation): void; get(id: string): StoredDelegation | null; del(id: string): void } {
  return {
    put(record) {
      const data = loadFile();
      const idx = data.delegations.findIndex((d) => d.ownerId === record.ownerId);
      if (idx >= 0) data.delegations[idx] = record;
      else data.delegations.push(record);
      persistFile(data);
    },
    get(ownerId) {
      return loadFile().delegations.find((d) => d.ownerId === ownerId) ?? null;
    },
    del(ownerId) {
      const data = loadFile();
      persistFile({ delegations: data.delegations.filter((d) => d.ownerId !== ownerId) });
    },
  };
}

// ── TinyCloud KV backend ─────────────────────────────────────────────

/** True when delegations should live in the backend's TinyCloud KV space. */
function useKv(): boolean {
  return config.secretsProvider === 'sdk';
}

function parseStored(raw: unknown): StoredDelegation | null {
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
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as StoredDelegation).serialized !== 'string' ||
    typeof (value as StoredDelegation).ownerId !== 'string'
  ) {
    return null;
  }
  return value as StoredDelegation;
}

function assertKvOk(result: unknown, op: string): void {
  if (
    result &&
    typeof result === 'object' &&
    'ok' in result &&
    (result as { ok?: unknown }).ok === false
  ) {
    const err = (result as { error?: { message?: unknown } }).error;
    const msg = typeof err?.message === 'string' ? err.message : 'TinyCloud KV write failed';
    throw new Error(`delegation-store: failed to ${op}: ${msg}`);
  }
}

// ── public API (async) ───────────────────────────────────────────────

export async function storeDelegation(record: StoredDelegation): Promise<void> {
  if (!useKv()) {
    fileStore().put(record);
    return;
  }
  const { node } = await getBackendIdentity();
  const result = await withSessionRefresh(node, () => node.kv.put(kvKey(record.ownerId), record));
  assertKvOk(result, `store delegation for ${record.ownerId}`);
}

export async function loadDelegation(ownerId: string): Promise<StoredDelegation | null> {
  if (!useKv()) {
    return fileStore().get(ownerId);
  }
  const { node } = await getBackendIdentity();
  const result = await withSessionRefresh(node, () => node.kv.get(kvKey(ownerId)));
  const data = (result as { data?: unknown })?.data ?? result;
  return parseStored(data);
}

export async function removeDelegation(ownerId: string): Promise<void> {
  if (!useKv()) {
    fileStore().del(ownerId);
    return;
  }
  const { node } = await getBackendIdentity();
  await withSessionRefresh(node, () => node.kv.delete(kvKey(ownerId)));
}
