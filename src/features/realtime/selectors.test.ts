import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState } from './reducer';
import { selectRealtimeStatus, selectVisibleMessagesForSession } from './selectors';

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
    };
    state.messages['m-2'] = {
      messageId: 'm-2',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'user',
      contentParts: [{ type: 'text', text: 'hi' }],
      status: 'committed',
      revision: 1,
    };

    const visible = selectVisibleMessagesForSession(state, 'agent:main:main');
    expect(visible.map((message) => message.messageId)).toEqual(['m-2', 'm-1']);
  });
});
