import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@/types';
import { createInitialRealtimeState, realtimeReducer } from './reducer';
import type { RealtimeEvent } from './types';
import {
  normalizeGatewayEvent,
  normalizeLocalRunCreated,
  normalizeSnapshotLoaded,
} from './normalizedEvent';

function apply(events: RealtimeEvent[]) {
  return events.reduce(realtimeReducer, createInitialRealtimeState());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalized realtime events', () => {
  it('uses wall-clock receivedAt so local run creation does not outrank later live updates', () => {
    vi.spyOn(Date, 'now').mockReturnValue(101);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 4,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        seq: 11,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    };

    const normalized = normalizeGatewayEvent(event);
    const state = apply([
      normalizeLocalRunCreated('agent:main:main', 'run-1', 100),
      ...normalized,
    ]);

    expect(normalized.map((entry) => entry.type)).toEqual([
      'run.status_changed',
      'message.delta_applied',
    ]);
    expect(normalized.map((entry) => entry.receivedAt)).toEqual([101, 101]);
    expect(state.runs['run-1']).toMatchObject({
      status: 'running',
      lastEventAt: 101,
      finalized: false,
    });
  });

  it('uses frameSeq as message revision when chat seq is missing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(140);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 41,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-frame',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      },
    };

    const normalized = normalizeGatewayEvent(event);

    expect(normalized).toMatchObject([
      {
        type: 'run.status_changed',
        receivedAt: 140,
      },
      {
        type: 'message.delta_applied',
        receivedAt: 140,
        revision: 41,
      },
    ]);
  });

  it('maps an agent lifecycle event into presence update when a phase exists', () => {
    vi.spyOn(Date, 'now').mockReturnValue(30);

    const event: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 3,
      payload: {
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    };

    const normalized = normalizeGatewayEvent(event);
    expect(normalized).toEqual([
      {
        type: 'agent.presence_updated',
        eventId: 'agent:30:agent:main:main',
        receivedAt: 30,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        presence: {
          sessionId: 'agent:main:main',
          agentId: 'main',
          phase: 'start',
          lastSeenAt: 30,
        },
      },
    ]);
  });

  it('does not emit presence updates for phase-less agent frames', () => {
    vi.spyOn(Date, 'now').mockReturnValue(44);

    const event: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 9,
      payload: {
        sessionKey: 'agent:main:main',
        stream: 'assistant',
        data: {},
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([]);
  });

  it('does not emit presence updates for whitespace-only agent state values', () => {
    vi.spyOn(Date, 'now').mockReturnValue(45);

    const event: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 10,
      payload: {
        sessionKey: 'agent:main:main',
        state: '   ',
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([]);
  });

  it('creates a local run-created event from send acknowledgement', () => {
    const normalized = normalizeLocalRunCreated('agent:main:main', 'run-9', 100);
    expect(normalized).toEqual({
      type: 'run.created',
      eventId: 'local:run-9:100',
      receivedAt: 100,
      source: 'local',
      sessionId: 'agent:main:main',
      runId: 'run-9',
    });
  });

  it('wraps snapshot payloads in a reducer event', () => {
    const normalized = normalizeSnapshotLoaded({
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 200,
        sourceVersion: 'snapshot-9',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 200,
      source: 'server-reconcile',
    });

    expect(normalized.type).toBe('snapshot.loaded');
  });

  it('emits running status even when a delta payload is a string', () => {
    vi.spyOn(Date, 'now').mockReturnValue(180);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 50,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-string-delta',
        state: 'delta',
        message: 'raw text',
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:180:run-string-delta:delta',
        receivedAt: 180,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-string-delta',
        status: 'running',
        finalized: false,
      },
    ]);
  });

  it('emits running status even when a delta payload has no extractable text', () => {
    vi.spyOn(Date, 'now').mockReturnValue(181);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 51,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-empty-delta',
        state: 'delta',
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:181:run-empty-delta:delta',
        receivedAt: 181,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-empty-delta',
        status: 'running',
        finalized: false,
      },
    ]);
  });

  it('normalizes chat final using one representative assistant message', () => {
    vi.spyOn(Date, 'now').mockReturnValue(220);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 7,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-2',
        seq: 12,
        state: 'final',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'old answer' }],
            createdAt: 10,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'fresh answer' }],
            createdAt: 150,
          },
        ],
      },
    };

    const normalized = normalizeGatewayEvent(event);

    expect(normalized).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:220:run-2:final',
        receivedAt: 220,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-2',
        status: 'completed',
        finalized: true,
      },
      {
        type: 'message.committed',
        eventId: 'chat:220:run-2:committed',
        receivedAt: 220,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'run-2:assistant',
          sessionId: 'agent:main:main',
          runId: 'run-2',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'fresh answer' }],
          status: 'committed',
          revision: 12,
          createdAt: 150,
        },
      },
    ]);
  });

  it('commits cleaned final text without tts or chart markers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(221);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 8,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-clean-final',
        seq: 13,
        state: 'final',
        message: {
          role: 'assistant',
          content:
            'Summary [tts:Spoken summary] [chart:{"type":"bar","data":{"labels":["Q1"],"values":[1]}}]',
          createdAt: 170,
        },
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:221:run-clean-final:final',
        receivedAt: 221,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-clean-final',
        status: 'completed',
        finalized: true,
      },
      {
        type: 'message.committed',
        eventId: 'chat:221:run-clean-final:committed',
        receivedAt: 221,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'run-clean-final:assistant',
          sessionId: 'agent:main:main',
          runId: 'run-clean-final',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'Summary' }],
          status: 'committed',
          revision: 13,
          createdAt: 170,
        },
      },
    ]);
  });

  it('keeps a frame-older late delta from overwriting a seq-less final commit', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(260).mockReturnValueOnce(270);

    const finalEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 20,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-out-of-order',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          createdAt: 255,
        },
      },
    };

    const lateDeltaEvent: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 19,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-out-of-order',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'stale partial' }],
        },
      },
    };

    const state = apply([
      ...normalizeGatewayEvent(finalEvent),
      ...normalizeGatewayEvent(lateDeltaEvent),
    ]);

    expect(state.runs['run-out-of-order']).toMatchObject({
      status: 'completed',
      finalized: true,
      lastEventAt: 260,
    });
    expect(state.messages['run-out-of-order:assistant']).toEqual({
      messageId: 'run-out-of-order:assistant',
      sessionId: 'agent:main:main',
      runId: 'run-out-of-order',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'done' }],
      status: 'committed',
      revision: 20,
      createdAt: 255,
    });
  });

  it('emits only terminal run status when final has no assistant message', () => {
    vi.spyOn(Date, 'now').mockReturnValue(280);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 60,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-no-assistant',
        state: 'final',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'question only' }],
            createdAt: 270,
          },
        ],
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:280:run-no-assistant:final',
        receivedAt: 280,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-no-assistant',
        status: 'completed',
        finalized: true,
      },
    ]);
  });

  it('maps chat error into a terminal failed run update', () => {
    vi.spyOn(Date, 'now').mockReturnValue(310);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-err',
        seq: 15,
        state: 'error',
        error: 'boom',
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:310:run-err:error',
        receivedAt: 310,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-err',
        status: 'failed',
        finalized: true,
      },
    ]);
  });

  it('maps chat aborted into a terminal interrupted run update', () => {
    vi.spyOn(Date, 'now').mockReturnValue(311);

    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-stop',
        seq: 16,
        state: 'aborted',
        stopReason: 'cancelled',
      },
    };

    expect(normalizeGatewayEvent(event)).toEqual([
      {
        type: 'run.status_changed',
        eventId: 'chat:311:run-stop:aborted',
        receivedAt: 311,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-stop',
        status: 'interrupted',
        finalized: true,
      },
    ]);
  });
});
