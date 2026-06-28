import {
  NonceStore,
  ServerAuthError,
  issueSessionToken as issueServerSessionToken,
  verifySessionToken as verifyServerSessionToken,
  verifySiweMessage,
} from '@tinycloud/server';

export interface OwnerAuth {
  /** Checksummed Ethereum address of the authenticated owner. */
  address: string;
}

export const nonceStore = new NonceStore();
export const verifySIWE = verifySiweMessage;
export const AuthError = ServerAuthError;

export async function issueSessionToken(
  address: string,
  privateKey: string,
): Promise<{ token: string; expiresIn: number }> {
  return issueServerSessionToken(address, privateKey);
}

export async function verifySessionToken(token: string, privateKey: string): Promise<OwnerAuth> {
  return verifyServerSessionToken(token, privateKey);
}
