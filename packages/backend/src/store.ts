import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from './config';

/**
 * DEV-LOCAL owner store.
 *
 * This is intentional, labeled dev behavior — NOT the real trust contract. In
 * production an owner's GitHub token + Anthropic key live in TinyCloud Secrets
 * and are read by the TEE under a delegation (deferred behind GITHAIKU_SECRETS_
 * PROVIDER=tc-cli). For the local preview we persist them to a gitignored JSON
 * file so the flow works end-to-end with no infra.
 *
 * The file is written under config.dataDir which is in .gitignore.
 */

export interface OwnerRecord {
  ownerId: string;
  /** GitHub login whose recent commits the haiku describes. */
  githubLogin: string;
  /** Dev-local secrets. In prod these live in TinyCloud Secrets. */
  githubToken: string | null;
  anthropicKey: string | null;
  /** The secret code a requester must present. Compared in constant time. */
  secretCode: string;
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

export interface CreateOwnerInput {
  githubLogin: string;
  githubToken?: string | null;
  anthropicKey?: string | null;
}

export interface CreateOwnerResult {
  ownerId: string;
  secretCode: string;
  githubLogin: string;
  hasGithubToken: boolean;
  hasAnthropicKey: boolean;
}

export function createOwner(input: CreateOwnerInput): CreateOwnerResult {
  const data = load();
  const record: OwnerRecord = {
    ownerId: generateOwnerId(),
    githubLogin: input.githubLogin,
    githubToken: input.githubToken ?? null,
    anthropicKey: input.anthropicKey ?? null,
    secretCode: generateSecretCode(),
    createdAt: new Date().toISOString(),
  };
  data.owners.push(record);
  persist(data);
  return {
    ownerId: record.ownerId,
    secretCode: record.secretCode,
    githubLogin: record.githubLogin,
    hasGithubToken: record.githubToken !== null,
    hasAnthropicKey: record.anthropicKey !== null,
  };
}

/** Plain lookup of an owner by id (not secret-sensitive — id is not a credential). */
export function findOwnerById(ownerId: string): OwnerRecord | null {
  return load().owners.find((o) => o.ownerId === ownerId) ?? null;
}

/**
 * Constant-time lookup of an owner by secret code.
 *
 * We compare the submitted code against EVERY stored code with
 * timingSafeEqual, accumulating the match, so lookup time does not reveal
 * which (or whether any) owner matched. Returns the owner or null.
 */
export function findOwnerByCode(submittedCode: string): OwnerRecord | null {
  const data = load();
  const submitted = Buffer.from(submittedCode, 'utf8');
  let matched: OwnerRecord | null = null;

  for (const owner of data.owners) {
    const stored = Buffer.from(owner.secretCode, 'utf8');
    // timingSafeEqual requires equal lengths; guard without early-returning on
    // the hot path so timing stays bounded by the stored set, not the input.
    const isMatch =
      stored.length === submitted.length && timingSafeEqual(stored, submitted);
    if (isMatch) {
      matched = owner;
    }
  }
  return matched;
}
