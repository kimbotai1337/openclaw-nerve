import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBadge } from './UpdateBadge';

describe('UpdateBadge', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: '1.5.2',
        latest: '1.5.3',
        updateAvailable: true,
        projectDir: '/tmp/nerve repo',
      }),
    })) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows a copy-paste update command with the project directory', async () => {
    const user = userEvent.setup();
    render(<UpdateBadge />);

    await user.click(await screen.findByRole('button', { name: /update available: version 1.5.3/i }));

    await waitFor(() => {
      expect(screen.getByText('Project directory')).toBeInTheDocument();
    });

    expect(screen.getByText('/tmp/nerve repo')).toBeInTheDocument();
    expect(screen.getByText("cd '/tmp/nerve repo' && npm run update -- --yes")).toBeInTheDocument();
    expect(screen.getByText(/cd '\/tmp\/nerve repo' && npm run update -- --dry-run/i)).toBeInTheDocument();
  });
});
