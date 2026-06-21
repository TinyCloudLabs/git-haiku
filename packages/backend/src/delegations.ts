import { deserializeDelegation, type PortableDelegation } from '@tinycloud/node-sdk';

import { SECRET_NAMES, secretVaultPath } from './policy';

/**
 * Delegation receipt + validation.
 *
 * The owner serializes a delegation (via `serializeDelegation`) whose audience
 * is the backend's stable did:pkh and whose resources cover KV-get on both
 * secret paths plus decrypt on the owner's default network. We deserialize it,
 * confirm coverage, and hand back the resources for the store. The CLI performs
 * the AUTHORITATIVE coverage check again at read time (delegationCoversPath /
 * delegationCoversDecrypt) — this is an early, loud sanity gate.
 *
 * Lifted from listen `backend/src/routes/delegations.ts` (resource extraction)
 * adapted to the portable-delegation `resources` breakdown.
 */

export interface DelegationResource {
  service: string;
  space?: string;
  path: string;
  actions: string[];
}

function extractResources(delegation: PortableDelegation): DelegationResource[] {
  // Multi-resource delegations expose the full breakdown in `resources`.
  // Single-resource (legacy) shape mirrors the first entry on the flat fields.
  const raw = Array.isArray(delegation.resources) ? delegation.resources : [];
  if (raw.length > 0) {
    return raw.map((r) => ({
      service: normalizeService(String(r.service)),
      ...(typeof r.space === 'string' ? { space: r.space } : {}),
      path: String(r.path),
      actions: Array.isArray(r.actions) ? r.actions.map(String) : [],
    }));
  }
  const flat = delegation as unknown as { path?: unknown; actions?: unknown };
  if (typeof flat.path === 'string' && Array.isArray(flat.actions)) {
    return [{ service: 'tinycloud.kv', path: flat.path, actions: flat.actions.map(String) }];
  }
  return [];
}

function normalizeService(service: string): string {
  return service.startsWith('tinycloud.') ? service : `tinycloud.${service}`;
}

/** True if any resource's path ends with the given secret vault path. */
function coversSecretPath(resources: DelegationResource[], vaultPath: string): boolean {
  return resources.some(
    (r) =>
      r.service === 'tinycloud.kv' &&
      (r.path === vaultPath || r.path.endsWith(`/${vaultPath}`) || r.path.endsWith(vaultPath)) &&
      r.actions.some((a) => a === 'get' || a.endsWith('/get')),
  );
}

function coversDecrypt(resources: DelegationResource[]): boolean {
  return resources.some(
    (r) =>
      r.service === 'tinycloud.encryption' &&
      r.actions.some((a) => a === 'decrypt' || a.endsWith('/decrypt')),
  );
}

export interface ValidatedDelegation {
  delegation: PortableDelegation;
  resources: DelegationResource[];
  expiresAt: string;
}

/**
 * Validate a serialized delegation covers the backend policy (both secret
 * KV-get paths + a decrypt entry), is addressed to this backend DID, and has a
 * valid future expiry. Throws loudly on any gap.
 */
export function validateDelegation(serialized: string, expectedBackendDid: string): ValidatedDelegation {
  let delegation: PortableDelegation;
  try {
    delegation = deserializeDelegation(serialized);
  } catch (err) {
    throw new Error(`delegation is not a valid serialized PortableDelegation: ${String(err)}`);
  }

  const resources = extractResources(delegation);
  const delegateDid = delegationAudienceDid(delegation);
  if (delegateDid !== expectedBackendDid) {
    throw new Error('delegation audience does not match this backend DID');
  }

  const expiresAt = parseFutureExpiry(delegation);

  for (const name of SECRET_NAMES) {
    if (!coversSecretPath(resources, secretVaultPath(name))) {
      throw new Error(`delegation does not cover KV get on vault/secrets/${name}`);
    }
  }
  if (!coversDecrypt(resources)) {
    throw new Error('delegation does not cover tinycloud.encryption/decrypt');
  }

  return { delegation, resources, expiresAt };
}

function delegationAudienceDid(delegation: PortableDelegation): string {
  const raw = (delegation as unknown as { delegateDID?: unknown }).delegateDID;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('delegation is missing delegateDID');
  }
  return raw;
}

function parseFutureExpiry(delegation: PortableDelegation): string {
  const exp = (delegation as unknown as { expiry?: unknown }).expiry;
  let date: Date | null = null;
  if (exp instanceof Date) {
    date = exp;
  } else if (typeof exp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(exp)) {
    date = new Date(exp);
  }

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error('delegation expiry is missing or unparseable');
  }
  if (date.getTime() <= Date.now()) {
    throw new Error('delegation is expired');
  }
  return date.toISOString();
}
