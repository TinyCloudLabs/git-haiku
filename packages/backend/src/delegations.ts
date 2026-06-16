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
  expiresAt: string | null;
}

/**
 * Validate a serialized delegation covers the backend policy (both secret
 * KV-get paths + a decrypt entry). Throws loudly on any gap.
 */
export function validateDelegation(serialized: string): ValidatedDelegation {
  let delegation: PortableDelegation;
  try {
    delegation = deserializeDelegation(serialized);
  } catch (err) {
    throw new Error(`delegation is not a valid serialized PortableDelegation: ${String(err)}`);
  }

  const resources = extractResources(delegation);

  for (const name of SECRET_NAMES) {
    if (!coversSecretPath(resources, secretVaultPath(name))) {
      throw new Error(`delegation does not cover KV get on vault/secrets/${name}`);
    }
  }
  if (!coversDecrypt(resources)) {
    throw new Error('delegation does not cover tinycloud.encryption/decrypt');
  }

  return { delegation, resources, expiresAt: expiryIso(delegation) };
}

function expiryIso(delegation: PortableDelegation): string | null {
  const exp = (delegation as unknown as { expiry?: unknown }).expiry;
  if (exp instanceof Date) return exp.toISOString();
  if (typeof exp === 'string') return exp;
  if (typeof exp === 'number') return new Date(exp).toISOString();
  return null;
}
