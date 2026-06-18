import { createHash } from 'node:crypto';

import { config } from './config';
import { getBackendIdentity } from './identity';
import { getDstackClient, inTee } from './tee';

/**
 * Attestation.
 *
 * IN-TEE (the real path): a dstack TDX quote over report_data bound to the
 * backend DID, plus the event log, compose_hash, app_id and os_image_hash from
 * the guest agent's Info RPC. These let an owner verify exactly what code is
 * handling their secrets.
 *
 * LOCAL/DEV: a clearly-marked stub (dev: true) — no fabricated quote.
 *
 * The `compose_hash` doubles as the haiku proof's `image_digest`: it is the
 * measurement of the exact compose (image + env policy) running in the CVM.
 */

export interface RealAttestation {
  dev: false;
  quote: string;
  event_log: string;
  compose_hash: string | null;
  app_id: string | null;
  instance_id: string | null;
  os_image_hash: string | null;
  report_data: string;
  did: string;
}

export interface DevAttestation {
  dev: true;
  note: string;
  quote: null;
  event_log: null;
  compose_hash: null;
  app_id: null;
}

export type Attestation = RealAttestation | DevAttestation;

const REPORT_DATA_PREFIX = 'githaiku-backend-attest-v1';

/**
 * report_data binds the quote to the backend DID. 64 hex chars (32 bytes) — the
 * TDX report_data field. sha256(prefix||did).
 */
function buildReportData(did: string): string {
  return createHash('sha256').update(`${REPORT_DATA_PREFIX}${did}`).digest('hex');
}

let cached: Attestation | null = null;

/** Produce the attestation for this instance. Memoized (stable per process). */
export async function getAttestation(): Promise<Attestation> {
  if (cached) return cached;

  if (!inTee()) {
    cached = {
      dev: true,
      note: 'dev stub — not running in a dstack TEE. No real TDX quote. proof.image_digest / attestation_url are dev placeholders.',
      quote: null,
      event_log: null,
      compose_hash: null,
      app_id: null,
    };
    return cached;
  }

  const { did } = await getBackendIdentity();
  const client = getDstackClient();
  const reportData = buildReportData(did);
  const quote = await client.getQuote(reportData);
  const info = await client.info();

  cached = {
    dev: false,
    quote: quote.quote,
    event_log: typeof quote.event_log === 'string' ? quote.event_log : JSON.stringify(quote.event_log),
    compose_hash: info.compose_hash ?? null,
    app_id: info.app_id ?? null,
    instance_id: info.instance_id ?? null,
    os_image_hash: info.os_image_hash ?? info.tcb_info?.os_image_hash ?? null,
    report_data: reportData,
    did,
  };
  return cached;
}

/** Reset memoized attestation (tests only). */
export function resetAttestation(): void {
  cached = null;
}

/**
 * The image measurement that the haiku proof's `image_digest` binds to: the
 * dstack compose_hash in-TEE, null (dev placeholder) otherwise.
 */
export async function imageDigest(): Promise<string | null> {
  const att = await getAttestation();
  return att.dev ? null : att.compose_hash;
}

/**
 * The public attestation URL the haiku proof points at. Built from the
 * configured public base URL; null in dev when none is set.
 */
export function attestationUrl(): string | null {
  if (!inTee()) return null;
  const base = config.publicUrl;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/attestation`;
}
