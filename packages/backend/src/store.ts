import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from './config';

/**
 * DEV-LOCAL owner store.
 *
 * This is intentional, labeled dev behavior — NOT the real trust contract. In
 * production an owner's GitHub token lives in TinyCloud Secrets and is read by
 * the TEE under a delegation (GITHAIKU_SECRETS_PROVIDER=tc-cli). For the local
 * preview we persist it to a gitignored JSON file so the flow works end-to-end
 * with no infra.
 *
 * SECRET CODES: an owner can hold MULTIPLE codes (create / revoke / rotate).
 * Only a sha256 HASH of each code is stored — the plaintext is shown ONCE at
 * creation/rotation and never persisted. Validation hashes the submitted code
 * and compares it constant-time against every active hash.
 *
 * The file is written under config.dataDir which is in .gitignore.
 */

export interface SecretCodeRecord {
  /** Stable id (sha256 prefix of the code) for revoke/audit without plaintext. */
  codeId: string;
  /** sha256(code) hex. The plaintext is never stored. */
  hash: string;
  createdAt: string;
  /** ISO string once revoked; null while active. */
  revokedAt: string | null;
}

export interface OwnerRecord {
  ownerId: string;
  /** GitHub login whose recent commits the haiku describes. */
  githubLogin: string;
  /** Dev-local secret. In prod this lives in TinyCloud Secrets. */
  githubToken: string | null;
  /** The owner's Ethereum address (lowercased) — used to authenticate them. */
  ownerAddress: string | null;
  /** Active + revoked secret codes (hashes only). */
  codes: SecretCodeRecord[];
  createdAt: string;
}

interface StoreFile {
  owners: OwnerRecord[];
}

const STORE_PATH = join(config.dataDir, 'owners.json');

function load(): StoreFile {
  if (!existsSync(STORE_PATH)) {
    return { owners: [] };
  }
  return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as StoreFile;
}

function persist(data: StoreFile): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function generateSecretCode(): string {
  // Human-shareable: 4 groups of 4 lowercase-base32-ish chars.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[raw[i]! % alphabet.length];
  }
  return out;
}

function generateOwnerId(): string {
  return 'own_' + randomBytes(8).toString('hex');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function codeIdFromHash(hash: string): string {
  return hash.slice(0, 16);
}

function newCodeRecord(): { record: SecretCodeRecord; plaintext: string } {
  const plaintext = generateSecretCode();
  const hash = hashCode(plaintext);
  return {
    plaintext,
    record: { codeId: codeIdFromHash(hash), hash, createdAt: new Date().toISOString(), revokedAt: null },
  };
}

export interface CreateOwnerInput {
  githubLogin: string;
  githubToken?: string | null;
  ownerAddress?: string | null;
}

export interface CreateOwnerResult {
  ownerId: string;
  /** The first code's plaintext — shown ONCE, never stored. */
  secretCode: string;
  codeId: string;
  githubLogin: string;
  hasGithubToken: boolean;
}

export function createOwner(input: CreateOwnerInput): CreateOwnerResult {
  const data = load();
  const { record: codeRecord, plaintext } = newCodeRecord();
  const record: OwnerRecord = {
    ownerId: generateOwnerId(),
    githubLogin: input.githubLogin,
    githubToken: input.githubToken ?? null,
    ownerAddress: input.ownerAddress ? input.ownerAddress.toLowerCase() : null,
    codes: [codeRecord],
    createdAt: new Date().toISOString(),
  };
  data.owners.push(record);
  persist(data);
  return {
    ownerId: record.ownerId,
    secretCode: plaintext,
    codeId: codeRecord.codeId,
    githubLogin: record.githubLogin,
    hasGithubToken: record.githubToken !== null,
  };
}

/** Plain lookup of an owner by id (not secret-sensitive — id is not a credential). */
export function findOwnerById(ownerId: string): OwnerRecord | null {
  return load().owners.find((o) => o.ownerId === ownerId) ?? null;
}

/** Lookup an owner by their (lowercased) Ethereum address. */
export function findOwnerByAddress(address: string): OwnerRecord | null {
  const addr = address.toLowerCase();
  return load().owners.find((o) => o.ownerAddress === addr) ?? null;
}

/**
 * Constant-time lookup of an owner by secret code.
 *
 * Hashes the submitted code, then compares against EVERY stored ACTIVE hash
 * with timingSafeEqual, accumulating the match, so lookup time does not reveal
 * which (or whether any) owner/code matched. Returns the owner or null.
 */
export function findOwnerByCode(submittedCode: string): OwnerRecord | null {
  const data = load();
  const submittedHash = Buffer.from(hashCode(submittedCode), 'utf8');
  let matched: OwnerRecord | null = null;

  for (const owner of data.owners) {
    for (const codeRec of owner.codes) {
      if (codeRec.revokedAt !== null) continue;
      const stored = Buffer.from(codeRec.hash, 'utf8');
      const isMatch =
        stored.length === submittedHash.length && timingSafeEqual(stored, submittedHash);
      if (isMatch) {
        matched = owner;
      }
    }
  }
  return matched;
}

// ── Code management (owner-authenticated) ────────────────────────────

export interface CodeSummary {
  codeId: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

function summarize(code: SecretCodeRecord): CodeSummary {
  return {
    codeId: code.codeId,
    createdAt: code.createdAt,
    revokedAt: code.revokedAt,
    active: code.revokedAt === null,
  };
}

/** List an owner's codes (metadata only — never the hash or plaintext). */
export function listCodes(ownerId: string): CodeSummary[] {
  const owner = findOwnerById(ownerId);
  if (!owner) throw new Error('unknown owner');
  return owner.codes.map(summarize);
}

/** Mint a new code for an owner. Returns the plaintext ONCE. */
export function createCode(ownerId: string): { codeId: string; secretCode: string } {
  const data = load();
  const owner = data.owners.find((o) => o.ownerId === ownerId);
  if (!owner) throw new Error('unknown owner');
  const { record, plaintext } = newCodeRecord();
  owner.codes.push(record);
  persist(data);
  return { codeId: record.codeId, secretCode: plaintext };
}

/** Revoke a specific code by codeId. Idempotent. */
export function revokeCode(ownerId: string, codeId: string): { codeId: string; revokedAt: string } {
  const data = load();
  const owner = data.owners.find((o) => o.ownerId === ownerId);
  if (!owner) throw new Error('unknown owner');
  const code = owner.codes.find((c) => c.codeId === codeId);
  if (!code) throw new Error('unknown codeId');
  if (code.revokedAt === null) code.revokedAt = new Date().toISOString();
  persist(data);
  return { codeId: code.codeId, revokedAt: code.revokedAt };
}

/**
 * Rotate: revoke ALL active codes and mint one fresh code. Returns the new
 * plaintext ONCE.
 */
export function rotateCodes(ownerId: string): { codeId: string; secretCode: string } {
  const data = load();
  const owner = data.owners.find((o) => o.ownerId === ownerId);
  if (!owner) throw new Error('unknown owner');
  const now = new Date().toISOString();
  for (const c of owner.codes) {
    if (c.revokedAt === null) c.revokedAt = now;
  }
  const { record, plaintext } = newCodeRecord();
  owner.codes.push(record);
  persist(data);
  return { codeId: record.codeId, secretCode: plaintext };
}
