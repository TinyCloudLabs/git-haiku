import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('backend runtime artifacts', () => {
  it('runs emitted JS in production instead of tsx from source', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/backend/package.json'), 'utf8')) as {
      scripts: { start: string; build: string };
      devDependencies: Record<string, string>;
      files: string[];
    };
    expect(pkg.scripts.start).toBe('node dist/index.js');
    expect(pkg.scripts.build).toContain('esbuild src/index.ts');
    expect(pkg.devDependencies).toHaveProperty('esbuild');
    expect(pkg.files).toEqual(['dist']);
  });

  it('Docker runtime copies only production dependencies and backend dist artifacts', () => {
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM build AS prod-deps');
    expect(dockerfile).toContain('pnpm --filter @githaiku/backend deploy --prod /runtime');
    expect(dockerfile).toContain('COPY --from=prod-deps /runtime ./');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
    expect(dockerfile).not.toContain('COPY --from=build /app /app');
    expect(dockerfile).not.toContain('CMD ["pnpm", "start"]');
  });
});
