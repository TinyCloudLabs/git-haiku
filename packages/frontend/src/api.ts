import { backendUrl } from './lib/config';

/**
 * Git Haiku backend client.
 *
 * Owner-authenticated calls use the SIWE-style header scheme from
 * packages/backend/src/auth.ts + server.ts:
 *   1. GET /api/auth/nonce            → { nonce }   (one-time, burned on use)
 *   2. sign `buildAuthMessage(nonce)` with the owner's key (OpenKey)
 *   3. send x-githaiku-address / x-githaiku-nonce / x-githaiku-signature
 *
 * Every authed request fetches a FRESH nonce because the backend burns it. The
 * signer is injected (the OpenKey session) so this module stays agnostic to how
 * the signature is produced.
 */

export const AUTH_MESSAGE_PREFIX = 'Git Haiku owner authentication';

/** The exact message the backend expects the owner to sign. */
export function buildAuthMessage(nonce: string): string {
  return `${AUTH_MESSAGE_PREFIX}\n\nNonce: ${nonce}`;
}

/** A signer that turns the canonical auth message into a hex signature. */
export type AuthSigner = (message: string) => Promise<string>;

/** Owner address + signer pair used to authenticate requests. */
export interface OwnerAuthContext {
  address: string;
  sign: AuthSigner;
}

// ── Public types (mirror the backend contract) ───────────────────────

export interface ServerInfoPermission {
  service: string;
  space?: string;
  path: string;
  actions: string[];
  skipPrefix?: boolean;
  description?: string;
}

export interface ServerInfo {
  did: string;
  name: string;
  permissions: ServerInfoPermission[];
}

export interface HaikuSuccess {
  allowed: true;
  haiku: { lines: [string, string, string] };
  proof: { policy_id: string; image_digest: string | null; attestation_url: string | null };
}
export interface HaikuDenial {
  allowed: false;
  reason: string;
}
export type HaikuResponse = HaikuSuccess | HaikuDenial;

/** Stages an owner preview can fail at (mirrors the backend egress guard). */
export type PreviewStage = 'secrets' | 'github' | 'generate' | 'internal';

export interface PreviewSuccess {
  allowed: true;
  haiku: { lines: [string, string, string] };
  proof: { policy_id: string; image_digest: string | null; attestation_url: string | null };
}
export interface PreviewDenial {
  allowed: false;
  reason: string;
  stage: PreviewStage;
}
export type PreviewResponse = PreviewSuccess | PreviewDenial;

export interface OwnerResult {
  ownerId: string;
  secretCode: string;
  codeId: string;
  githubLogin: string;
  hasGithubToken: boolean;
}

export interface DelegationResult {
  status: string;
  expiresAt: string;
}

export interface CodeSummary {
  codeId: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface MintedCode {
  codeId: string;
  secretCode: string;
}

export interface AuditEntry {
  codeId: string;
  ownerId: string | null;
  ts: string;
  decision: 'allow' | 'deny';
  reason: string;
  policyId: string;
}

// ── Low-level helpers ─────────────────────────────────────────────────

async function getNonce(): Promise<string> {
  const res = await fetch(backendUrl('/api/auth/nonce'));
  if (!res.ok) throw new Error(`nonce request failed (${res.status})`);
  const body = (await res.json()) as { nonce?: string };
  if (!body.nonce) throw new Error('nonce missing in response');
  return body.nonce;
}

/** Build the three owner-auth headers for one request (fresh nonce + signature). */
async function authHeaders(auth: OwnerAuthContext): Promise<Record<string, string>> {
  const nonce = await getNonce();
  const signature = await auth.sign(buildAuthMessage(nonce));
  return {
    'x-githaiku-address': auth.address,
    'x-githaiku-nonce': nonce,
    'x-githaiku-signature': signature,
  };
}

async function authedFetch(
  path: string,
  auth: OwnerAuthContext,
  init: RequestInit = {},
): Promise<Response> {
  const headers = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(await authHeaders(auth)),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(backendUrl(path), { ...init, headers });
}

async function jsonOrThrow<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `${context} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ── Public (no auth) ──────────────────────────────────────────────────

export async function getServerInfo(): Promise<ServerInfo> {
  const res = await fetch(backendUrl('/api/server-info'));
  return jsonOrThrow<ServerInfo>(res, 'server-info');
}

export async function requestHaiku(code: string): Promise<HaikuResponse> {
  const res = await fetch(backendUrl('/api/haiku'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return (await res.json()) as HaikuResponse;
}

// ── Owner-authenticated ───────────────────────────────────────────────

/**
 * Read the owner record bound to the authenticated address WITHOUT minting a
 * code. Returns `null` when no owner record exists yet (HTTP 404); any other
 * failure throws so the caller surfaces the error.
 */
export async function getOwner(auth: OwnerAuthContext): Promise<OwnerResult | null> {
  const res = await authedFetch('/api/owner', auth);
  if (res.status === 404) return null;
  return jsonOrThrow<OwnerResult>(res, 'load owner');
}

export async function registerOwner(
  auth: OwnerAuthContext,
  input: { githubLogin: string },
): Promise<OwnerResult> {
  const res = await authedFetch('/api/owner', auth, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow<OwnerResult>(res, 'owner registration');
}

export async function sendDelegation(
  auth: OwnerAuthContext,
  input: { ownerId: string; serialized: string },
): Promise<DelegationResult> {
  const res = await authedFetch('/api/delegations', auth, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow<DelegationResult>(res, 'delegation');
}

export async function listCodes(auth: OwnerAuthContext): Promise<CodeSummary[]> {
  const res = await authedFetch('/api/codes', auth);
  const body = await jsonOrThrow<{ codes: CodeSummary[] }>(res, 'list codes');
  return body.codes;
}

export async function mintCode(auth: OwnerAuthContext): Promise<MintedCode> {
  const res = await authedFetch('/api/codes', auth, { method: 'POST' });
  return jsonOrThrow<MintedCode>(res, 'mint code');
}

export async function rotateCodes(auth: OwnerAuthContext): Promise<MintedCode> {
  const res = await authedFetch('/api/codes/rotate', auth, { method: 'POST' });
  return jsonOrThrow<MintedCode>(res, 'rotate codes');
}

export async function revokeCode(
  auth: OwnerAuthContext,
  codeId: string,
): Promise<{ codeId: string; revokedAt: string }> {
  const res = await authedFetch('/api/codes/revoke', auth, {
    method: 'POST',
    body: JSON.stringify({ codeId }),
  });
  return jsonOrThrow<{ codeId: string; revokedAt: string }>(res, 'revoke code');
}

/**
 * Owner end-to-end preview: drive the full egress (read stored token → fetch
 * GitHub activity → generate → guard) and return the haiku WITHOUT minting a
 * code. Success is HTTP 200 `{allowed:true, haiku, proof}`; a staged failure is
 * non-2xx `{allowed:false, reason, stage}`. We read the JSON body in BOTH cases
 * so the caller can key its message off `stage`. No request body; owner SIWE
 * auth headers only.
 */
export async function previewHaiku(auth: OwnerAuthContext): Promise<PreviewResponse> {
  const res = await authedFetch('/api/preview', auth, { method: 'POST' });
  const body = (await res.json().catch(() => null)) as PreviewResponse | null;
  if (!body || typeof body.allowed !== 'boolean') {
    throw new Error(`preview failed (${res.status})`);
  }
  return body;
}

export async function getAudit(auth: OwnerAuthContext): Promise<AuditEntry[]> {
  const res = await authedFetch('/api/audit', auth);
  const body = await jsonOrThrow<{ entries: AuditEntry[] }>(res, 'audit');
  return body.entries;
}
