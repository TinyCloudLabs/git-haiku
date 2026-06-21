import { createOwner } from './store';

/**
 * Dev seed: create one owner with NO GitHub token (so the haiku renders from the
 * built-in fixture) and print the secret code for the requester flow.
 *
 * Run: pnpm --filter @githaiku/backend seed
 */
const result = createOwner({
  githubLogin: process.env['SEED_GITHUB_LOGIN'] ?? 'octocat',
  githubToken: process.env['SEED_GITHUB_TOKEN'] ?? null,
});

// eslint-disable-next-line no-console
console.log(JSON.stringify(result, null, 2));
// eslint-disable-next-line no-console
console.log(`\nSecret code for the requester: ${result.secretCode}`);
