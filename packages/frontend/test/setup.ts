import '@testing-library/react';

// jsdom lacks clipboard; stub it so copy buttons don't throw in tests.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async () => {} },
    configurable: true,
  });
}
