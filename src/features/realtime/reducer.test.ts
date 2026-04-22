import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState, realtimeReducer } from './reducer';
import type { RealtimeEvent, RealtimeSnapshotPayload } from './types';

function apply(stateEvents: RealtimeEvent[]) {
  return stateEvents.reduce(realtimeReducer, createInitialRealtimeState());
}

describe('realtimeReducer', () => {
  it('creates a run from local send and finalizes it from snapshot truth', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-1',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'completed',
          messageIds: ['assistant-1'],
          lastEventAt: 20,
          finalized: true,
        },
      ],
      messages: [
        {
          messageId: 'assistant-1',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'done' }],
          status: 'committed',
          revision: 2,
          createdAt: 19,
        },
      ],
      agentPresence: {
        sessionId: 'agent:main:main',
        agentId: 'main',
        phase: 'idle',
        lastSeenAt: 20,
      },
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'run.created',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'local',
        sessionId: 'agent:main:main',
        runId: 'run-1',
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-2',
        receivedAt: 20,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
    ]);

    expect(state.runs['run-1']?.status).toBe('completed');
    expect(state.runs['run-1']?.finalized).toBe(true);
    expect(state.messages['assistant-1']?.contentParts).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('marks reconcile needed when ordering becomes uncertain', () => {
    const state = apply([
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-1',
        receivedAt: 30,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'chat-gap',
      },
    ]);

    expect(state.connection.reconcileNeeded).toBe(true);
    expect(state.connection.status).toBe('reconnecting');
  });

  it('does not mutate the previous run entity when committing a message', () => {
    const baseState = apply([
      {
        type: 'run.created',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'local',
        sessionId: 'agent:main:main',
        runId: 'run-1',
      },
    ]);

    const previousRun = baseState.runs['run-1'];

    const nextState = realtimeReducer(baseState, {
      type: 'message.committed',
      eventId: 'evt-2',
      receivedAt: 11,
      source: 'live-chat',
      sessionId: 'agent:main:main',
      message: {
        messageId: 'assistant-1',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        role: 'assistant',
        contentParts: [{ type: 'text', text: 'done' }],
        status: 'committed',
        revision: 1,
        createdAt: 11,
      },
    });

    expect(previousRun).toBeDefined();
    expect(previousRun?.messageIds).toEqual([]);
    expect(nextState.runs['run-1']).not.toBe(previousRun);
    expect(nextState.runs['run-1']?.messageIds).toEqual(['assistant-1']);
  });

  it('replaces session-scoped snapshot state authoritatively and clears absent presence', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-2',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'completed',
          messageIds: [],
          lastEventAt: 20,
          finalized: true,
        },
      ],
      messages: [],
      agentPresence: null,
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'run.created',
        eventId: 'evt-1',
        receivedAt: 1,
        source: 'local',
        sessionId: 'agent:main:main',
        runId: 'run-1',
      },
      {
        type: 'message.committed',
        eventId: 'evt-2',
        receivedAt: 2,
        source: 'local',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-local',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'draft' }],
          status: 'committed',
          revision: 1,
          createdAt: 2,
        },
      },
      {
        type: 'run.created',
        eventId: 'evt-3',
        receivedAt: 3,
        source: 'local',
        sessionId: 'agent:main:main',
        runId: 'run-stale',
      },
      {
        type: 'message.committed',
        eventId: 'evt-4',
        receivedAt: 4,
        source: 'local',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-stale',
          sessionId: 'agent:main:main',
          runId: 'run-stale',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'stale' }],
          status: 'committed',
          revision: 1,
          createdAt: 4,
        },
      },
      {
        type: 'agent.presence_updated',
        eventId: 'evt-5',
        receivedAt: 5,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        presence: {
          sessionId: 'agent:main:main',
          agentId: 'main',
          phase: 'running',
          lastSeenAt: 5,
        },
      },
      {
        type: 'run.created',
        eventId: 'evt-6',
        receivedAt: 6,
        source: 'local',
        sessionId: 'agent:other:other',
        runId: 'run-other',
      },
      {
        type: 'message.committed',
        eventId: 'evt-7',
        receivedAt: 7,
        source: 'local',
        sessionId: 'agent:other:other',
        message: {
          messageId: 'assistant-other',
          sessionId: 'agent:other:other',
          runId: 'run-other',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'keep' }],
          status: 'committed',
          revision: 1,
          createdAt: 7,
        },
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-8',
        receivedAt: 20,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
    ]);

    expect(state.runs['run-1']?.messageIds).toEqual([]);
    expect(state.runs['run-stale']).toBeUndefined();
    expect(state.messages['assistant-local']).toBeUndefined();
    expect(state.messages['assistant-stale']).toBeUndefined();
    expect(state.agentPresence['agent:main:main']).toBeUndefined();
    expect(state.runs['run-other']?.runId).toBe('run-other');
    expect(state.messages['assistant-other']?.messageId).toBe('assistant-other');
  });

  it('keeps a committed message when a streaming delta arrives at the same revision', () => {
    const committedMessage = {
      messageId: 'assistant-1',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant' as const,
      contentParts: [{ type: 'text' as const, text: 'final answer' }],
      status: 'committed' as const,
      revision: 3,
      createdAt: 10,
    };

    const state = apply([
      {
        type: 'message.committed',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        message: committedMessage,
      },
      {
        type: 'message.delta_applied',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        messageId: 'assistant-1',
        text: 'partial',
        revision: 3,
      },
    ]);

    expect(state.messages['assistant-1']).toEqual(committedMessage);
  });
});
