import { existsSync } from 'node:fs';

import { DstackClient, type GetQuoteResponse, type InfoResponse } from '@phala/dstack-sdk';

/**
 * dstack TEE boundary.
 *
 * Inside a Phala dstack CVM the guest agent exposes a unix socket
 * (/var/run/dstack.sock) for key derivation (GetKey), TDX quoting (GetQuote)
 * and instance info (Info). Outside the TEE that socket does not exist and the
 * @phala/dstack-sdk DstackClient constructor THROWS, so we never construct it
 * unless the TEE is actually present.
 *
 * Detection: GITHAIKU_TEE=1 (set in the dstack compose) OR a dstack socket on
 * disk. Either signal means "we are in the TEE; use the real dstack RPCs".
 */

const DSTACK_SOCKET_PATHS = [
  '/var/run/dstack.sock',
  '/run/dstack.sock',
  '/var/run/dstack/dstack.sock',
  '/run/dstack/dstack.sock',
];

/** A dstack socket exists on disk (or a simulator endpoint is configured). */
export function dstackSocketPresent(): boolean {
  if (process.env['DSTACK_SIMULATOR_ENDPOINT']) return true;
  return DSTACK_SOCKET_PATHS.some((p) => existsSync(p));
}

/**
 * True when we should use the real dstack RPCs: explicitly flagged in-TEE
 * (GITHAIKU_TEE=1) or a dstack socket is reachable. When this is false the
 * backend runs in dev mode (env-provided key, clearly-labeled dev attestation).
 */
export function inTee(): boolean {
  return process.env['GITHAIKU_TEE'] === '1' || dstackSocketPresent();
}

/**
 * Construct a dstack client. Caller MUST gate this behind inTee()/socket
 * presence — the SDK constructor throws if no socket is reachable. We surface
 * that loudly rather than masking it.
 */
export function getDstackClient(): DstackClient {
  if (!dstackSocketPresent()) {
    throw new Error(
      'dstack client requested but no dstack socket is reachable. This must only ' +
        'be called inside a dstack TEE (GITHAIKU_TEE=1 implies the socket exists).',
    );
  }
  return new DstackClient();
}

export type { GetQuoteResponse, InfoResponse };
