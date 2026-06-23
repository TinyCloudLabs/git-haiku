import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { HowSafe } from '../src/components/HowSafe';

afterEach(cleanup);

describe('HowSafe', () => {
  it('renders the trust contract and both verify sections', () => {
    render(<HowSafe />);
    expect(screen.getByRole('heading', { name: /how is this safe/i })).toBeTruthy();
    expect(screen.getByText(/the trust contract/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /verify it yourself — attestation/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /verify it yourself — the code/i })).toBeTruthy();
  });

  it('links to the live attestation endpoint and the public source', () => {
    render(<HowSafe />);
    const attestation = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.endsWith('/attestation'));
    expect(attestation).toBeTruthy();

    const repo = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === 'https://github.com/TinyCloudLabs/git-haiku');
    expect(repo).toBeTruthy();
    expect(repo!.getAttribute('target')).toBe('_blank');
    expect(repo!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('surfaces a copyable verification prompt pointing at attestation + source', () => {
    render(<HowSafe />);
    expect(screen.getByText(/verification prompt for your AI agent/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
    // The prompt names the attestation, the raw README source, and the egress guard.
    expect(screen.getByText(/refs\/heads\/main\/README\.md/)).toBeTruthy();
    expect(screen.getByText(/egress guard in packages\/shared/)).toBeTruthy();
  });
});
