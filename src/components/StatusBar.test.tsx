import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar';

vi.mock('@/contexts/GatewayContext', () => ({
  useGateway: () => ({
    connectionState: 'connected',
  }),
}));

vi.mock('./UpdateBadge', () => ({
  UpdateBadge: () => null,
}));

describe('StatusBar realtime status', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', 'test');
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('renders SYNCING when reconcile is in progress', () => {
    render(
      <StatusBar
        connectionState="connected"
        realtimeStatus="syncing"
        sessionCount={2}
        sparkline="▁▂▃▄"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('SYNCING');
  });
});
