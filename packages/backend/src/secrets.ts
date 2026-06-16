import { config } from './config';
import type { OwnerRecord } from './store';

/**
 * Secrets boundary.
 *
 * In the real trust contract, the owner's GitHub token + Anthropic key live in
 * TinyCloud Secrets and the TEE reads them under a received delegation. That is
 * DEFERRED behind GITHAIKU_SECRETS_PROVIDER=tc-cli. For the preview we use the
 * dev-local store. The SecretsProvider interface is the seam the tc-CLI impl
 * slots into later.
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

/**
 * DEFERRED: read the owner's secrets from TinyCloud Secrets under a delegation
 * via `@tinycloud/cli@0.7.0-beta.1` (`tc secrets get <NAME> --delegation ...`).
 *
 * Wiring this requires a running TinyCloud node + a stored delegation, which the
 * preview deliberately does not need. Selecting this provider throws so the
 * fallback is never silent — this is a flagged seam, not an error mask.
 */
class TcCliSecretsProvider implements SecretsProvider {
  readonly kind = 'tc-cli';
  async getOwnerSecrets(_owner: OwnerRecord): Promise<OwnerSecrets> {
    throw new Error(
      'tc-cli secrets provider is deferred: it requires a TinyCloud node + delegation. ' +
        'Run the preview with GITHAIKU_SECRETS_PROVIDER=local (default).',
    );
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
