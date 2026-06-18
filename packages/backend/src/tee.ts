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
 * Detection is split into intent and verified capability:
 *  - intent: GITHAIKU_TEE=1 or NODE_ENV=production means this process is
 *    configured for real TEE/prod behavior and must fail startup if dstack does
 *    not work.
 *  - capability: only a successful dstack key derivation + quote/info probe
 *    marks this process as verified in-TEE.
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

/** Configured intent: startup must prove dstack works in this mode. */
export function teeModeRequested(): boolean {
  return process.env['GITHAIKU_TEE'] === '1' || process.env['NODE_ENV'] === 'production';
}

/** We should attempt real dstack RPCs when intent is set or a socket is found. */
export function shouldUseDstack(): boolean {
  return teeModeRequested() || dstackSocketPresent();
}

let verifiedTee = false;

/** Verified capability: true only after key derivation plus quote/info succeed. */
export function inTee(): boolean {
  return verifiedTee;
}

export function markTeeVerified(): void {
  verifiedTee = true;
}

/** Reset verified capability (tests only). */
export function resetTeeVerification(): void {
  verifiedTee = false;
}

/**
 * Construct a dstack client. Caller MUST gate this behind shouldUseDstack()
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
