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
