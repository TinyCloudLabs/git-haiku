import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'shared',
      environment: 'node',
      include: ['packages/shared/test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'backend',
      environment: 'node',
      include: ['packages/backend/test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'frontend',
      environment: 'node',
      include: ['packages/frontend/test/**/*.test.ts'],
    },
  },
]);

