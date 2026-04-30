import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState, realtimeReducer } from './reducer';
import { selectSessionIsGenerating } from './selectors';
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
        type: 'connection.opened',
        eventId: 'evt-0',
        receivedAt: 20,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 0,
      },
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
    expect(state.connection.status).toBe('live');
  });

  it('returns to offline when the transport reaches a terminal disconnect', () => {
    const state = apply([
      {
        type: 'connection.opened',
        eventId: 'evt-0',
        receivedAt: 20,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 0,
      },
      {
        type: 'connection.offline',
        eventId: 'evt-1',
        receivedAt: 30,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'intentional-close',
      },
    ]);

    expect(state.connection.status).toBe('offline');
    expect(state.connection.lastDisconnectReason).toBe('intentional-close');
    expect(state.connection.reconnectAttempt).toBe(0);
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

  it('finalizes sibling active runs when a terminal final arrives under a different run id', () => {
    const state = apply([
      {
        type: 'run.status_changed',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'send-ack-run',
        status: 'running',
        finalized: false,
      },
      {
        type: 'message.delta_applied',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'send-ack-run',
        messageId: 'send-ack-run:assistant',
        text: 'N',
        revision: 11,
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-3',
        receivedAt: 12,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'final-answer-run',
        status: 'completed',
        finalized: true,
      },
      {
        type: 'message.committed',
        eventId: 'evt-4',
        receivedAt: 12,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'final-answer-run:assistant',
          sessionId: 'agent:main:main',
          runId: 'final-answer-run',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'NERVE_DUP_FIX_SMOKE_20260430_L' }],
          status: 'committed',
          revision: 12,
          createdAt: 12,
        },
      },
    ]);

    expect(state.runs['send-ack-run']).toEqual(expect.objectContaining({
      status: 'completed',
      finalized: true,
    }));
    expect(state.messages['send-ack-run:assistant']).toEqual(expect.objectContaining({
      status: 'superseded',
    }));
    expect(selectSessionIsGenerating(state, 'agent:main:main')).toBe(false);
  });

  it('keeps transport health independent while reconciliation resolves', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'running',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-transport',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const pendingState = apply([
      {
        type: 'connection.opened',
        eventId: 'evt-1',
        receivedAt: 1,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 0,
      },
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-2',
        receivedAt: 2,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'chat-gap',
      },
      {
        type: 'connection.opened',
        eventId: 'evt-3',
        receivedAt: 3,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 1,
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-4',
        receivedAt: 4,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
    ]);

    expect(pendingState.connection.status).toBe('live');
    expect(pendingState.connection.reconcileNeeded).toBe(true);
    expect(pendingState.connection.lastLiveAt).toBe(3);

    const mergedState = realtimeReducer(pendingState, {
      type: 'snapshot.merge_completed',
      eventId: 'evt-5',
      receivedAt: 5,
      source: 'snapshot',
      sessionId: 'agent:main:main',
    });

    expect(mergedState.connection.status).toBe('live');
    expect(mergedState.connection.reconcileNeeded).toBe(false);
  });

  it('does not let snapshot loading overwrite current transport status', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'running',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-degraded',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'connection.opened',
        eventId: 'evt-1',
        receivedAt: 1,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 0,
      },
      {
        type: 'connection.degraded',
        eventId: 'evt-2',
        receivedAt: 2,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reason: 'slow-link',
      },
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-3',
        receivedAt: 3,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'chat-gap',
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-4',
        receivedAt: 4,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
    ]);

    expect(state.connection.status).toBe('degraded');
    expect(state.connection.reconcileNeeded).toBe(true);
    expect(state.connection.lastDisconnectReason).toBe('slow-link');
  });

  it('rejects a stale snapshot when local session activity is newer', () => {
    const staleSnapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'v1',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'queued',
          messageIds: [],
          lastEventAt: 20,
          finalized: false,
        },
      ],
      messages: [],
      agentPresence: null,
      recoveredAt: 30,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'session.upserted',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        session: {
          sessionId: 'agent:main:main',
          status: 'running',
          agentId: 'main',
          updatedAt: 20,
          sourceVersion: 'v1',
        },
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-2',
        receivedAt: 40,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'running',
        finalized: false,
      },
      {
        type: 'message.committed',
        eventId: 'evt-3',
        receivedAt: 41,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-live',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'still running' }],
          status: 'committed',
          revision: 1,
          createdAt: 40,
        },
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-4',
        receivedAt: 42,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot: staleSnapshot,
      },
    ]);

    expect(state.sessions['agent:main:main']?.status).toBe('running');
    expect(state.runs['run-1']?.status).toBe('running');
    expect(state.runs['run-1']?.lastEventAt).toBe(40);
    expect(state.messages['assistant-live']?.messageId).toBe('assistant-live');
  });

  it('accepts a newer snapshot even when browser-stamped activity is ahead of recoveredAt', () => {
    const freshSnapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 30,
        sourceVersion: 'v2',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'completed',
          messageIds: ['assistant-1'],
          lastEventAt: 30,
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
          createdAt: 29,
        },
      ],
      agentPresence: null,
      recoveredAt: 25,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'session.upserted',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        session: {
          sessionId: 'agent:main:main',
          status: 'running',
          agentId: 'main',
          updatedAt: 20,
          sourceVersion: 'v1',
        },
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-2',
        receivedAt: 100,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'running',
        finalized: false,
      },
      {
        type: 'message.committed',
        eventId: 'evt-3',
        receivedAt: 101,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-live',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'draft' }],
          status: 'committed',
          revision: 1,
          createdAt: 101,
        },
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-4',
        receivedAt: 102,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot: freshSnapshot,
      },
    ]);

    expect(state.sessions['agent:main:main']).toEqual(freshSnapshot.session);
    expect(state.runs['run-1']).toEqual(freshSnapshot.runs[0]);
    expect(state.messages['assistant-1']).toEqual(freshSnapshot.messages[0]);
    expect(state.messages['assistant-live']).toBeUndefined();
  });

  it('rejects a stale snapshot when newer local run and message state exist without session metadata', () => {
    const staleSnapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'v1',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'completed',
          messageIds: ['assistant-stale'],
          lastEventAt: 20,
          finalized: true,
        },
      ],
      messages: [
        {
          messageId: 'assistant-stale',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'old snapshot answer' }],
          status: 'committed',
          revision: 1,
          createdAt: 20,
        },
      ],
      agentPresence: null,
      recoveredAt: 30,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'run.status_changed',
        eventId: 'evt-1',
        receivedAt: 40,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'running',
        finalized: false,
      },
      {
        type: 'message.committed',
        eventId: 'evt-2',
        receivedAt: 41,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-live',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'newer local answer' }],
          status: 'committed',
          revision: 2,
          createdAt: 40,
        },
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-3',
        receivedAt: 42,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot: staleSnapshot,
      },
    ]);

    expect(state.runs['run-1']).toMatchObject({
      status: 'running',
      finalized: false,
      lastEventAt: 40,
    });
    expect(state.messages['assistant-live']).toMatchObject({
      messageId: 'assistant-live',
      revision: 2,
    });
    expect(state.messages['assistant-stale']).toBeUndefined();
  });

  it('ends syncing when a requested snapshot is stale but local state is newer', () => {
    const staleSnapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'v1',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'connection.opened',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        reconnectAttempt: 0,
      },
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'chat-gap',
      },
      {
        type: 'session.upserted',
        eventId: 'evt-3',
        receivedAt: 12,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        session: {
          sessionId: 'agent:main:main',
          status: 'running',
          agentId: 'main',
          updatedAt: 30,
          sourceVersion: 'v2',
        },
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-4',
        receivedAt: 13,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot: staleSnapshot,
      },
      {
        type: 'snapshot.merge_completed',
        eventId: 'evt-5',
        receivedAt: 14,
        source: 'snapshot',
        sessionId: 'agent:main:main',
      },
    ]);

    expect(state.sessions['agent:main:main']?.status).toBe('running');
    expect(state.connection.reconcileNeeded).toBe(false);
  });

  it('keeps reconcile needed until every overlapping snapshot request has finished', () => {
    const pendingState = apply([
      {
        type: 'connection.opened',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'local',
        sessionId: 'global',
        reconnectAttempt: 0,
      },
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'session-switch',
      },
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-3',
        receivedAt: 12,
        source: 'local',
        sessionId: 'agent:reviewer:main',
        reason: 'session-switch',
      },
    ]);

    expect(pendingState.connection.reconcileNeeded).toBe(true);

    const oneFinishedState = realtimeReducer(pendingState, {
      type: 'snapshot.merge_completed',
      eventId: 'evt-4',
      receivedAt: 13,
      source: 'snapshot',
      sessionId: 'agent:main:main',
    });

    expect(oneFinishedState.connection.reconcileNeeded).toBe(true);

    const allFinishedState = realtimeReducer(oneFinishedState, {
      type: 'snapshot.merge_completed',
      eventId: 'evt-5',
      receivedAt: 14,
      source: 'snapshot',
      sessionId: 'agent:reviewer:main',
    });

    expect(allFinishedState.connection.reconcileNeeded).toBe(false);
  });

  it('keeps finalized runs terminal and ignores duplicate run.created events', () => {
    const state = apply([
      {
        type: 'run.status_changed',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'completed',
        finalized: true,
      },
      {
        type: 'run.created',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-3',
        receivedAt: 12,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'running',
        finalized: false,
      },
    ]);

    expect(state.runs['run-1']).toEqual({
      runId: 'run-1',
      sessionId: 'agent:main:main',
      status: 'completed',
      messageIds: [],
      lastEventAt: 10,
      finalized: true,
    });
  });

  it('creates a placeholder run when a committed message arrives before run events', () => {
    const state = apply([
      {
        type: 'message.committed',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        message: {
          messageId: 'assistant-1',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'hello' }],
          status: 'committed',
          revision: 1,
          createdAt: 9,
        },
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-2',
        receivedAt: 11,
        source: 'live-agent',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'running',
        finalized: false,
      },
    ]);

    expect(state.runs['run-1']).toEqual({
      runId: 'run-1',
      sessionId: 'agent:main:main',
      status: 'running',
      messageIds: ['assistant-1'],
      lastEventAt: 11,
      finalized: false,
    });
  });

  it('accepts a finalized live update even when snapshot time is ahead of receivedAt', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'running',
        agentId: 'main',
        updatedAt: 200,
        sourceVersion: 'snapshot-1',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'running',
          messageIds: [],
          lastEventAt: 200,
          finalized: false,
        },
      ],
      messages: [],
      agentPresence: null,
      recoveredAt: 200,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'snapshot.loaded',
        eventId: 'evt-1',
        receivedAt: 200,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
      {
        type: 'run.status_changed',
        eventId: 'evt-2',
        receivedAt: 100,
        source: 'live-chat',
        sessionId: 'agent:main:main',
        runId: 'run-1',
        status: 'completed',
        finalized: true,
      },
    ]);

    expect(state.runs['run-1']?.status).toBe('completed');
    expect(state.runs['run-1']?.finalized).toBe(true);
  });
});
