import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@/types';
import type { RealtimeSnapshotPayload } from '@/features/realtime/types';

let subscribedHandler: ((event: GatewayEvent) => void) | null = null;

const gatewayMockState = {
  connectionState: 'connected' as const,
  reconnectAttempt: 0,
  transportMeta: {
    lastCloseCode: null as number | null,
    lastCloseReason: null as string | null,
    connectedAt: 10,
  },
  subscribe: (handler: (event: GatewayEvent) => void) => {
    subscribedHandler = handler;
    return () => {
      subscribedHandler = null;
    };
  },
};

vi.mock('./GatewayContext', () => ({
  useGateway: () => gatewayMockState,
}));

describe('RealtimeProvider', () => {
  beforeEach(() => {
    subscribedHandler = null;
    gatewayMockState.connectionState = 'connected';
    gatewayMockState.reconnectAttempt = 0;
    gatewayMockState.transportMeta = {
      lastCloseCode: null,
      lastCloseReason: null,
      connectedAt: 10,
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches normalized gateway events into reducer state', async () => {
    const mod = await import('./RealtimeContext');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <mod.RealtimeProvider>{children}</mod.RealtimeProvider>
    );

    const { result } = renderHook(() => mod.useRealtime(), { wrapper });

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        seq: 1,
        payload: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          seq: 2,
          state: 'delta',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.state.runs['run-1']).toMatchObject({
        runId: 'run-1',
        status: 'running',
        finalized: false,
      });
      expect(result.current.state.messages['run-1:assistant']).toMatchObject({
        status: 'streaming',
        contentParts: [{ type: 'text', text: 'hello' }],
      });
    });
  });

  it('requests a snapshot reconcile and merges the returned session state', async () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-1',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 21,
      source: 'server-reconcile',
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, snapshot }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./RealtimeContext');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <mod.RealtimeProvider>{children}</mod.RealtimeProvider>
    );

    const { result } = renderHook(() => mod.useRealtime(), { wrapper });

    await act(async () => {
      await result.current.requestSnapshot('agent:main:main', 'reconnect');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/realtime/snapshot?sessionKey=agent%3Amain%3Amain');
    expect(result.current.state.sessions['agent:main:main']).toEqual(snapshot.session);
    expect(result.current.state.connection.reconcileNeeded).toBe(false);
    expect(result.current.realtimeStatus).toBe('live');
  });

  it('keeps reconcileNeeded set when snapshot reconcile fails', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./RealtimeContext');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <mod.RealtimeProvider>{children}</mod.RealtimeProvider>
    );

    const { result } = renderHook(() => mod.useRealtime(), { wrapper });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.requestSnapshot('agent:main:main', 'reconnect');
      } catch (error) {
        thrown = error;
      }
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/realtime/snapshot?sessionKey=agent%3Amain%3Amain');
    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.state.connection.reconcileNeeded).toBe(true);
    expect(result.current.realtimeStatus).toBe('syncing');
  });

  it('keeps disconnected transport classified as offline', async () => {
    gatewayMockState.connectionState = 'disconnected';
    gatewayMockState.transportMeta = {
      lastCloseCode: 1006,
      lastCloseReason: 'socket-closed',
      connectedAt: null,
    };

    const mod = await import('./RealtimeContext');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <mod.RealtimeProvider>{children}</mod.RealtimeProvider>
    );

    const { result } = renderHook(() => mod.useRealtime(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.connection.status).toBe('offline');
      expect(result.current.realtimeStatus).toBe('offline');
    });
  });
});
