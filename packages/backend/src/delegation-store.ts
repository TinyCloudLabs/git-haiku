import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from './config';

/**
 * Per-owner delegation store.
 *
 * Persists the owner's serialized delegation so the tc-cli SecretsProvider can
 * read the owner's secrets under it. DEV-LOCAL: a gitignored JSON file (the
 * brief permits dev-local persistence). In a hardened deployment this would be
 * the backend's own TinyCloud KV (listen `packages/server/src/delegation-store.ts`).
 *
 * Keyed by ownerId. The stored `serialized` is the CLI delegation candidate
 * artifact ({ delegation: PortableDelegation, ... }) that `tc secrets get
 * --delegation <file>` consumes.
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

interface StoreFile {
  delegations: StoredDelegation[];
}

const STORE_PATH = join(config.dataDir, 'delegations.json');

function load(): StoreFile {
  if (!existsSync(STORE_PATH)) return { delegations: [] };
  return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as StoreFile;
}

function persist(data: StoreFile): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function storeDelegation(record: StoredDelegation): void {
  const data = load();
  const idx = data.delegations.findIndex((d) => d.ownerId === record.ownerId);
  if (idx >= 0) {
    data.delegations[idx] = record;
  } else {
    data.delegations.push(record);
  }
  persist(data);
}

export function loadDelegation(ownerId: string): StoredDelegation | null {
  const data = load();
  return data.delegations.find((d) => d.ownerId === ownerId) ?? null;
}

export function removeDelegation(ownerId: string): void {
  const data = load();
  persist({ delegations: data.delegations.filter((d) => d.ownerId !== ownerId) });
}
