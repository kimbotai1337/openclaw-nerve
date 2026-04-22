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
});
