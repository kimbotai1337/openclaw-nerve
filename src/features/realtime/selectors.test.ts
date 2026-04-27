import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState } from './reducer';
import {
  isTerminalAgentPhase,
  selectRealtimeStatus,
  selectSessionAgentPresence,
  selectSessionIsGenerating,
  selectVisibleMessagesForSession,
} from './selectors';

describe('realtime selectors', () => {
  it('returns syncing while reconcile is still pending, even if transport is degraded', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'degraded';
    state.connection.reconcileNeeded = true;

    expect(selectRealtimeStatus(state)).toBe('syncing');
  });

  it('returns offline while reconcile is pending if transport is offline', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'offline';
    state.connection.reconcileNeeded = true;

    expect(selectRealtimeStatus(state)).toBe('offline');
  });

  it('returns reconnecting while reconcile is pending if transport is reconnecting', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'reconnecting';
    state.connection.reconcileNeeded = true;

    expect(selectRealtimeStatus(state)).toBe('reconnecting');
  });

  it('returns degraded once reconcile is no longer pending', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'degraded';
    state.connection.reconcileNeeded = false;

    expect(selectRealtimeStatus(state)).toBe('degraded');
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

  it('derives generating from local queued runs before agent presence catches up', () => {
    const state = createInitialRealtimeState();
    state.runs['run-1'] = {
      runId: 'run-1',
      sessionId: 'agent:main:main',
      status: 'queued',
      messageIds: [],
      lastEventAt: 10,
      finalized: false,
    };

    expect(selectSessionIsGenerating(state, 'agent:main:main')).toBe(true);
  });

  it('treats terminal agent phases as not generating', () => {
    const state = createInitialRealtimeState();
    state.agentPresence['agent:main:main'] = {
      sessionId: 'agent:main:main',
      agentId: 'main',
      phase: 'cancelled',
      lastSeenAt: 10,
    };

    expect(selectSessionIsGenerating(state, 'agent:main:main')).toBe(false);
    expect(isTerminalAgentPhase('cancelled')).toBe(true);
    expect(isTerminalAgentPhase('running')).toBe(false);
  });
});
