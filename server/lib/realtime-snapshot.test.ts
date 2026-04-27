import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayRpcCallMock = vi.hoisted(() => vi.fn());

vi.mock('./gateway-rpc.js', () => ({
  gatewayRpcCall: gatewayRpcCallMock,
}));

describe('buildRealtimeSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps session and history data into an authoritative snapshot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    gatewayRpcCallMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.list') {
        expect(params).toEqual({ activeMinutes: 24 * 60, limit: 200 });
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              state: 'running',
              agentState: 'thinking',
              updatedAt: 900,
              runId: 'run-active',
              currentRunId: 'run-active',
              latestRunId: 'run-active',
              busy: true,
              processing: true,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        expect(params).toEqual({ sessionKey: 'agent:main:main', limit: 25 });
        return {
          messages: [
            {
              role: 'user',
              content: 'Question',
              timestamp: 850,
              runId: 'run-active',
            },
            {
              role: 'assistant',
              content: 'Summary [tts:spoken] [chart:{"type":"bar","data":{"labels":["Q1"],"values":[1]}}]',
              createdAt: 860,
              runId: 'run-active',
              messageId: 'assistant-1',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 25 });

    expect(snapshot).toEqual({
      session: {
        sessionId: 'agent:main:main',
        status: 'running',
        agentId: 'main',
        updatedAt: 900,
        sourceVersion: '900|running|thinking|run-active|run-active|run-active|1|1|0',
      },
      runs: [
        {
          runId: 'run-active',
          sessionId: 'agent:main:main',
          status: 'running',
          messageIds: [
            'agent:main:main:run-active:user:850:0',
            'assistant-1',
          ],
          lastEventAt: 900,
          finalized: false,
        },
      ],
      messages: [
        {
          messageId: 'agent:main:main:run-active:user:850:0',
          sessionId: 'agent:main:main',
          runId: 'run-active',
          role: 'user',
          contentParts: [{ type: 'text', text: 'Question' }],
          status: 'committed',
          revision: 850,
          createdAt: 850,
        },
        {
          messageId: 'assistant-1',
          sessionId: 'agent:main:main',
          runId: 'run-active',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'Summary' }],
          charts: [
            {
              type: 'bar',
              data: {
                labels: ['Q1'],
                values: [1],
              },
            },
          ],
          status: 'committed',
          revision: 860,
          createdAt: 860,
        },
      ],
      agentPresence: {
        sessionId: 'agent:main:main',
        agentId: 'main',
        phase: 'thinking',
        lastSeenAt: 900,
      },
      recoveredAt: 1_700_000_000_000,
      source: 'server-reconcile',
    });
  });

  it('handles missing history payloads without failing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'idle',
              updatedAt: 1_700,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {};
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 10 });

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.agentPresence).toEqual({
      sessionId: 'agent:main:main',
      agentId: 'main',
      phase: 'idle',
      lastSeenAt: 1_700,
    });
    expect(snapshot.session.sourceVersion).toBe('1700|idle|||||0|0|0');
  });

  it('preserves chart-only assistant finals recovered from history', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'done',
              updatedAt: 4_900,
              latestRunId: 'run-chart',
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: '[chart:{"type":"line","data":{"labels":["Jan"],"values":[3]}}]',
              createdAt: 4_850,
              runId: 'run-chart',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        runId: 'run-chart',
        contentParts: [],
        charts: [
          {
            type: 'line',
            data: {
              labels: ['Jan'],
              values: [3],
            },
          },
        ],
      }),
    ]);
    expect(snapshot.runs).toEqual([
      expect.objectContaining({
        runId: 'run-chart',
        status: 'completed',
        finalized: true,
      }),
    ]);
  });

  it('keeps historical run timestamps instead of promoting them to the latest session update', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'running',
              updatedAt: 9_900,
              currentRunId: 'run-current',
              latestRunId: 'run-current',
              busy: true,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'older completion',
              createdAt: 8_000,
              runId: 'run-old',
            },
            {
              role: 'assistant',
              content: 'newer completion',
              createdAt: 9_850,
              runId: 'run-current',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    expect(snapshot.runs).toEqual([
      expect.objectContaining({
        runId: 'run-old',
        lastEventAt: 8_000,
        status: 'completed',
        finalized: true,
      }),
      expect.objectContaining({
        runId: 'run-current',
        lastEventAt: 9_900,
        status: 'running',
        finalized: false,
      }),
    ]);
  });
});
