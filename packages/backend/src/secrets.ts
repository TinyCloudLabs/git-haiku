import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { config } from './config';
import { loadDelegation } from './delegation-store';
import { SECRET_NAMES, type SecretName } from './policy';
import type { OwnerRecord } from './store';

const execFileAsync = promisify(execFile);

/**
 * Secrets boundary.
 *
 * - LOCAL (default): the owner's GitHub token + Anthropic key come straight from
 *   the gitignored dev store. No TinyCloud node needed.
 * - TC-CLI: the real trust contract. The owner's secrets live in TinyCloud
 *   Secrets; the backend reads them under the owner's delegation by invoking the
 *   real `tc` binary (`tc secrets get <NAME> --delegation <file> --host <node>
 *   --json`). Secrets stay in memory — never written to disk (except the
 *   transient delegation file, deleted immediately) or logs.
 */
export interface OwnerSecrets {
  githubToken: string | null;
  anthropicKey: string | null;
}

export interface SecretsProvider {
  readonly kind: string;
  getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets>;
}

/** DEV-LOCAL: secrets come straight from the gitignored owner store. */
class LocalSecretsProvider implements SecretsProvider {
  readonly kind = 'local';
  async getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets> {
    return {
      githubToken: owner.githubToken,
      anthropicKey: owner.anthropicKey,
    };
  }
}

/** Map secret NAME -> OwnerSecrets field. */
const SECRET_FIELD: Record<SecretName, keyof OwnerSecrets> = {
  GITHUB_TOKEN: 'githubToken',
  ANTHROPIC_API_KEY: 'anthropicKey',
};

/**
 * Resolve the absolute path to the published `tc` binary. We resolve the CLI's
 * own entrypoint and run it with the current node — no global install needed.
 */
function resolveTcEntry(): string {
  const require = createRequire(import.meta.url);
  // The package's bin is dist/index.js; main resolves to the same module dir.
  const pkgJson = require.resolve('@tinycloud/cli/package.json');
  const dir = pkgJson.slice(0, pkgJson.lastIndexOf('/'));
  return join(dir, 'dist', 'index.js');
}

/**
 * REAL: read the owner's secrets from TinyCloud Secrets under their stored
 * delegation via the `tc` CLI. Fails LOUDLY if no node / delegation / key.
 */
class TcCliSecretsProvider implements SecretsProvider {
  readonly kind = 'tc-cli';
  private readonly tcEntry = resolveTcEntry();

  async getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets> {
    const privateKey = config.backendPrivateKey;
    if (!privateKey) {
      throw new Error(
        'tc-cli provider requires GITHAIKU_BACKEND_PRIVATE_KEY (the backend stable identity ' +
          'that owners delegate to).',
      );
    }

    const stored = loadDelegation(owner.ownerId);
    if (!stored) {
      throw new Error(
        `tc-cli provider: no stored delegation for owner ${owner.ownerId}. ` +
          'The owner must POST /api/delegations first.',
      );
    }

    // Write the delegation to a transient file (the only on-disk secret-adjacent
    // artifact) under a 0700 temp dir, deleted in `finally`.
    const dir = mkdtempSync(join(tmpdir(), 'githaiku-deleg-'));
    const delegationFile = join(dir, 'delegation.json');
    writeFileSync(delegationFile, stored.serialized, { encoding: 'utf8', mode: 0o600 });

    try {
      const out: OwnerSecrets = { githubToken: null, anthropicKey: null };
      for (const name of SECRET_NAMES) {
        out[SECRET_FIELD[name]] = await this.readSecret(name, delegationFile, privateKey);
      }
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async readSecret(
    name: SecretName,
    delegationFile: string,
    privateKey: string,
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        this.tcEntry,
        'secrets',
        'get',
        name,
        '--delegation',
        delegationFile,
        '--host',
        config.nodeHost,
        '--json',
      ],
      {
        // Backend stable key in env, NOT argv (argv is world-readable via ps).
        env: { ...process.env, TC_PRIVATE_KEY: privateKey },
        maxBuffer: 1024 * 1024,
      },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`tc secrets get ${name}: non-JSON output`);
    }
    const value = (parsed as { value?: unknown }).value;
    if (typeof value !== 'string') {
      throw new Error(`tc secrets get ${name}: missing string value in output`);
    }
    return value;
  }
}

export function makeSecretsProvider(): SecretsProvider {
  switch (config.secretsProvider) {
    case 'local':
      return new LocalSecretsProvider();
    case 'tc-cli':
      return new TcCliSecretsProvider();
  }
}
