import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState } from './reducer';
import { selectRealtimeStatus, selectSessionAgentPresence, selectVisibleMessagesForSession } from './selectors';

describe('realtime selectors', () => {
  it('returns syncing when reconcile is in progress', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'reconnecting';
    state.connection.reconcileNeeded = true;

    expect(selectRealtimeStatus(state)).toBe('syncing');
  });

  it('orders messages by revision and commit state for a session', () => {
    const state = createInitialRealtimeState();
    state.messages['m-1'] = {
      messageId: 'm-1',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'done' }],
      status: 'committed',
      revision: 2,
      createdAt: 20,
    };
    state.messages['m-2'] = {
      messageId: 'm-2',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'user',
      contentParts: [{ type: 'text', text: 'hi' }],
      status: 'committed',
      revision: 1,
      createdAt: 10,
    };

    const visible = selectVisibleMessagesForSession(state, 'agent:main:main');
    expect(visible.map((message) => message.messageId)).toEqual(['m-2', 'm-1']);
  });

  it('orders same-revision messages by createdAt with a deterministic tie-breaker', () => {
    const state = createInitialRealtimeState();
    state.messages['m-9'] = {
      messageId: 'm-9',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'third' }],
      status: 'committed',
      revision: 2,
      createdAt: 30,
    };
    state.messages['m-3'] = {
      messageId: 'm-3',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'second' }],
      status: 'committed',
      revision: 2,
      createdAt: 20,
    };
    state.messages['m-1'] = {
      messageId: 'm-1',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'first-a' }],
      status: 'committed',
      revision: 2,
      createdAt: 10,
    };
    state.messages['m-2'] = {
      messageId: 'm-2',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'first-b' }],
      status: 'committed',
      revision: 2,
      createdAt: 10,
    };

    const visible = selectVisibleMessagesForSession(state, 'agent:main:main');

    expect(visible.map((message) => message.messageId)).toEqual(['m-1', 'm-2', 'm-3', 'm-9']);
  });

  it('returns agent presence for a session and null when it is absent', () => {
    const state = createInitialRealtimeState();
    state.agentPresence['agent:main:main'] = {
      sessionId: 'agent:main:main',
      agentId: 'main',
      phase: 'running',
      lastSeenAt: 10,
    };

    expect(selectSessionAgentPresence(state, 'agent:main:main')).toEqual({
      sessionId: 'agent:main:main',
      agentId: 'main',
      phase: 'running',
      lastSeenAt: 10,
    });
    expect(selectSessionAgentPresence(state, 'agent:other:other')).toBeNull();
  });
});
