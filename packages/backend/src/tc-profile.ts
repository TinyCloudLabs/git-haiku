import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { config } from './config';

/**
 * Bootstrap a LOCAL `tc` profile so the delegated `secrets get` can authenticate
 * the DELEGATE's own identity.
 *
 * Why this exists: in `@tinycloud/cli@0.7`, `tc secrets get --delegation` still
 * authenticates the delegate via `ensureSecretsNode -> ensureAuthenticated`,
 * which ONLY accepts an identity from (A) a persisted LOCAL PROFILE
 * (`authMethod === "local"` + `privateKey`) or (B) a login session.
 * `TC_PRIVATE_KEY`/`--private-key` is read by `authOptions()` but only reaches
 * `createSDKInstance` AFTER that gate — so with no profile and no session it is
 * never used and the CLI throws AUTH_REQUIRED. We therefore write a minimal
 * local-key profile that makes branch (A) fire; `createSDKInstance` then builds
 * the node from `profile.privateKey` (no jwk key file required) and proceeds
 * with the delegated read.
 *
 * The CLI's `ProfileManager` resolves `PROFILES_DIR` from `os.homedir()` (i.e.
 * `$HOME` on POSIX) at module load, so we point the spawned `node` process at a
 * dedicated `HOME` and write `<HOME>/.tinycloud/profiles/default/profile.json`.
 *
 * Security: the private key is persisted to a 0600 `profile.json` under a 0700
 * dir inside this process's ephemeral FS (the enclave). This is the
 * CLI-required tradeoff — the key still never reaches argv, and is never logged.
 */

const DEFAULT_PROFILE = 'default';

interface TcProfileEnv {
  /** Value to set as `HOME` (and `TC_HOME`) for the spawned `tc` process. */
  home: string;
  /** The default profile name written. */
  profile: string;
}

let memoized: TcProfileEnv | null = null;

/**
 * Ensure a local-key `tc` profile exists for the backend's stable key, in a
 * process-lifetime HOME we control. Memoized: the key is stable, so we write the
 * profile once per process. Returns the env additions the caller must pass to
 * the spawned `tc` process.
 */
export function ensureLocalTcProfile(privateKey: string): TcProfileEnv {
  if (memoized) return memoized;

  // Faithful to what `tc init` writes for a local-key profile.
  const account = privateKeyToAccount(privateKey as Hex);
  const address = account.address;
  const did = `did:pkh:eip155:1:${address}`;

  // A 0700 HOME for this process's lifetime.
  const home = mkdtempSync(join(tmpdir(), 'githaiku-tchome-'));
  const profileDir = join(home, '.tinycloud', 'profiles', DEFAULT_PROFILE);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  // OMIT all session / openkey / auth-login fields. Only the local-key profile
  // fields the CLI's getProfile / resolveContext / createSDKInstance read.
  const profile = {
    name: DEFAULT_PROFILE,
    host: config.nodeHost,
    chainId: 1,
    did,
    address,
    createdAt: new Date().toISOString(),
    posture: 'local-owner-key',
    operatorType: 'human',
    authMethod: 'local',
    privateKey,
  };

  writeFileSync(join(profileDir, 'profile.json'), JSON.stringify(profile, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });

  memoized = { home, profile: DEFAULT_PROFILE };
  return memoized;
}

/** Reset memoized profile env (tests only). */
export function resetLocalTcProfile(): void {
  memoized = null;
}
