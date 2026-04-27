import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '../../src/types';
import { normalizeGatewayEvent, normalizeSnapshotLoaded } from '../../src/features/realtime/normalizedEvent';
import { createInitialRealtimeState, realtimeReducer } from '../../src/features/realtime/reducer';

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
            'run-active:assistant',
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
          messageId: 'run-active:assistant',
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
          revision: -1,
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

  it('lets active-run snapshot assistants accept later live updates', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'running',
              agentState: 'thinking',
              updatedAt: 1_950,
              currentRunId: 'run-live',
              latestRunId: 'run-live',
              busy: true,
              processing: true,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'snapshot answer',
              createdAt: 1_900,
              runId: 'run-live',
              messageId: 'history-live-1',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    const deltaEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 1,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-live',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'live partial' }] },
      },
    };

    const finalEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 2,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-live',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'live final' }],
          createdAt: 1_975,
        },
      },
    };

    const state = [
      normalizeSnapshotLoaded(snapshot),
      ...normalizeGatewayEvent(deltaEvent),
      ...normalizeGatewayEvent(finalEvent),
    ].reduce(realtimeReducer, createInitialRealtimeState());

    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        messageId: 'run-live:assistant',
        revision: -1,
        contentParts: [{ type: 'text', text: 'snapshot answer' }],
      }),
    ]);
    expect(Object.keys(state.messages)).toEqual(['run-live:assistant']);
    expect(state.messages['run-live:assistant']).toMatchObject({
      status: 'committed',
      revision: 2,
      contentParts: [{ type: 'text', text: 'live final' }],
      createdAt: 1_975,
    });
    expect(state.runs['run-live']).toMatchObject({
      status: 'completed',
      finalized: true,
    });
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

  it('does not reopen a stale latestRunId when a different currentRunId is active', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(12_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'running',
              updatedAt: 11_900,
              currentRunId: 'run-current',
              latestRunId: 'run-older',
              busy: true,
              processing: true,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return { messages: [] };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    expect(snapshot.runs).toEqual([
      {
        runId: 'run-current',
        sessionId: 'agent:main:main',
        status: 'running',
        messageIds: [],
        lastEventAt: 11_900,
        finalized: false,
      },
    ]);
  });

  it('keeps a last-run placeholder terminal when the session is idle and history is gone', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(13_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'idle',
              updatedAt: 12_900,
              latestRunId: 'run-last',
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return { messages: [] };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    expect(snapshot.runs).toEqual([
      {
        runId: 'run-last',
        sessionId: 'agent:main:main',
        status: 'completed',
        messageIds: [],
        lastEventAt: 12_900,
        finalized: true,
      },
    ]);
  });

  it('uses the live assistant message id for explicit history finals so late live events do not create a second entity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(14_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'done',
              updatedAt: 13_900,
              latestRunId: 'run-interop',
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'final answer',
              createdAt: 13_850,
              runId: 'run-interop',
              messageId: 'history-final-1',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    const deltaEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 1,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-interop',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'late token' }] },
      },
    };

    const finalEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 2,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-interop',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          createdAt: 13_850,
        },
      },
    };

    const state = [
      normalizeSnapshotLoaded(snapshot),
      ...normalizeGatewayEvent(deltaEvent),
      ...normalizeGatewayEvent(finalEvent),
    ].reduce(realtimeReducer, createInitialRealtimeState());

    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        messageId: 'run-interop:assistant',
      }),
    ]);
    expect(Object.keys(state.messages)).toEqual(['run-interop:assistant']);
    expect(state.messages['run-interop:assistant']).toMatchObject({
      status: 'committed',
      contentParts: [{ type: 'text', text: 'final answer' }],
    });
  });

  it('keeps fallback assistant ids unique within a run while reserving the live id for the latest message', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(14_500);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'done',
              updatedAt: 14_400,
              latestRunId: 'run-multi-assistant',
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'earlier answer',
              createdAt: 14_100,
              runId: 'run-multi-assistant',
              messageId: 'run-multi-assistant:assistant',
            },
            {
              role: 'assistant',
              content: 'latest answer',
              createdAt: 14_200,
              runId: 'run-multi-assistant',
              messageId: 'assistant-latest-explicit',
            },
          ],
        };
      }

      throw new Error(`Unexpected RPC ${method}`);
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 5 });

    expect(snapshot.messages).toHaveLength(2);
    expect(new Set(snapshot.messages.map((message) => message.messageId)).size).toBe(2);
    expect(snapshot.messages[0]?.messageId).toBe('agent:main:main:run-multi-assistant:assistant:14100:0');
    expect(snapshot.messages[1]?.messageId).toBe('run-multi-assistant:assistant');
    expect(snapshot.runs).toEqual([
      {
        runId: 'run-multi-assistant',
        sessionId: 'agent:main:main',
        status: 'completed',
        messageIds: [
          'agent:main:main:run-multi-assistant:assistant:14100:0',
          'run-multi-assistant:assistant',
        ],
        lastEventAt: 14_400,
        finalized: true,
      },
    ]);
    expect(new Set(snapshot.runs[0]!.messageIds).size).toBe(snapshot.runs[0]!.messageIds.length);
  });

  it('strips user transport decorations and ignores invalid upload manifests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_000);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'idle',
              updatedAt: 14_900,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'user',
              createdAt: 14_850,
              content: 'Conversation info (untrusted metadata):\n{"message_id":"m-1","sender":"webchat"}\n[Wed 2026-04-24 12:00 GMT+3] [voice] Hello from voice\n\n<nerve-upload-manifest>{"version":1,"attachments":[{"id":"att-1"}]}</nerve-upload-manifest>\n\n[system: User sent a voice message. Always include your full text reply AND a [tts:...] marker so it plays back as audio.]',
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
        role: 'user',
        contentParts: [{ type: 'text', text: 'Hello from voice' }],
      }),
    ]);
    expect(snapshot.messages[0]).not.toHaveProperty('uploadAttachments');
  });

  it('drops malformed upload manifests without leaking raw manifest text', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_250);

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'idle',
              updatedAt: 15_200,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'user',
              createdAt: 15_150,
              content: 'Please use this file.\n\n<nerve-upload-manifest>{"version":1,"attachments":[</nerve-upload-manifest>',
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
        role: 'user',
        contentParts: [{ type: 'text', text: 'Please use this file.' }],
      }),
    ]);
    expect(snapshot.messages[0]).not.toHaveProperty('uploadAttachments');
  });

  it('preserves manifest-only user messages as attachment-only realtime entities', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_500);

    const manifestAttachments = [
      {
        id: 'att-path',
        origin: 'server_path',
        mode: 'file_reference',
        name: 'capture.mov',
        mimeType: 'video/quicktime',
        sizeBytes: 8_000_000,
        reference: {
          kind: 'local_path',
          path: '/workspace/capture.mov',
          uri: 'file:///workspace/capture.mov',
        },
        policy: {
          forwardToSubagents: true,
        },
      },
    ];

    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              sessionKey: 'agent:main:main',
              status: 'idle',
              updatedAt: 15_400,
            },
          ],
        };
      }

      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'user',
              createdAt: 15_300,
              content: `<nerve-upload-manifest>${JSON.stringify({ version: 1, attachments: manifestAttachments })}</nerve-upload-manifest>`,
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
        role: 'user',
        contentParts: [],
        uploadAttachments: manifestAttachments,
      }),
    ]);
  });
});
