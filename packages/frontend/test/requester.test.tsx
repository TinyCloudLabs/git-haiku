import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { requestHaiku } = vi.hoisted(() => ({ requestHaiku: vi.fn() }));
vi.mock('../src/api', () => ({ requestHaiku }));

import { Requester } from '../src/components/Requester';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Requester', () => {
  it('renders a haiku and the MCP panel on success', async () => {
    requestHaiku.mockResolvedValue({
      allowed: true,
      haiku: { lines: ['line one here', 'a second line appears now', 'and then the third'] },
      proof: { policy_id: 'secret-code-v1', image_digest: null, attestation_url: null },
    });
    const user = userEvent.setup();
    render(<Requester />);

    await user.type(screen.getByLabelText('secret code'), 'aaaa-bbbb-cccc-dddd');
    await user.click(screen.getByRole('button', { name: /get haiku/i }));

    await screen.findByText('line one here');
    expect(screen.getByText(/policy: secret-code-v1/)).toBeTruthy();
    // MCP panel appears for a valid code.
    await screen.findByText(/use it from an agent \(mcp\)/i);
    expect(screen.getByText(/git_haiku/i, { selector: 'pre' })).toBeTruthy();
  });

  it('renders a denial and no MCP panel', async () => {
    requestHaiku.mockResolvedValue({ allowed: false, reason: 'invalid code' });
    const user = userEvent.setup();
    render(<Requester />);

    await user.type(screen.getByLabelText('secret code'), 'bad-code');
    await user.click(screen.getByRole('button', { name: /get haiku/i }));

    await screen.findByText(/no haiku/i);
    await waitFor(() => {
      expect(screen.queryByText(/use it from an agent/i)).toBeNull();
    });
  });
});
