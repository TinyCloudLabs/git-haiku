import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { requestHaiku, requestWeeklyReport } = vi.hoisted(() => ({
  requestHaiku: vi.fn(),
  requestWeeklyReport: vi.fn(),
}));
vi.mock('../src/api', () => ({ requestHaiku, requestWeeklyReport }));

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
      author: { githubLogin: 'skgbafa' },
      proof: { policy_id: 'secret-code-v1', image_digest: null, attestation_url: null },
    });
    const user = userEvent.setup();
    render(<Requester />);

    await user.type(screen.getByLabelText('secret code'), 'aaaa-bbbb-cccc-dddd');
    await user.click(screen.getByRole('button', { name: /get haiku/i }));

    await screen.findByText('line one here');
    const author = await screen.findByRole('link', { name: '@skgbafa' });
    expect(author.getAttribute('href')).toBe('https://github.com/skgbafa');
    expect(screen.getByRole('link', { name: 'github.com/skgbafa' }).getAttribute('href')).toBe(
      'https://github.com/skgbafa',
    );
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

  it('renders a weekly report with the same code', async () => {
    requestWeeklyReport.mockResolvedValue({
      allowed: true,
      report: {
        githubLogin: 'skgbafa',
        generatedAt: '2026-06-29T14:00:00Z',
        range: { start: '2026-06-22', end: '2026-06-28' },
        commitCount: 1,
        generatedBy: 'deterministic',
        overview: 'Shipped report sharing.',
        days: [
          {
            date: '2026-06-22',
            weekday: 'Monday',
            commitCount: 1,
            repos: ['TinyCloudLabs/git-haiku'],
            summary: 'Worked on TinyCloudLabs/git-haiku with one commit.',
            highlights: ['git-haiku: feat: share report'],
          },
        ],
      },
    });
    const user = userEvent.setup();
    render(<Requester initialKind="report" initialCode="aaaa-bbbb-cccc-dddd" />);

    await user.click(screen.getByRole('button', { name: /get report/i }));

    expect(requestWeeklyReport).toHaveBeenCalledWith('aaaa-bbbb-cccc-dddd');
    await screen.findByText(/last week report/i);
    expect(screen.getByText(/shipped report sharing/i)).toBeTruthy();
    expect(screen.getByText(/git-haiku: feat: share report/i)).toBeTruthy();
    expect(screen.queryByText(/use it from an agent/i)).toBeNull();
  });
});
