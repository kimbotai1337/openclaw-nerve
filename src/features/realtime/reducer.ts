import type {
  RealtimeEvent,
  RealtimeMessageEntity,
  RealtimeRunEntity,
  RealtimeState,
} from './types';

export function createInitialRealtimeState(): RealtimeState {
  return {
    connection: {
      status: 'offline',
      lastLiveAt: 0,
      lastDisconnectReason: null,
      reconcileNeeded: false,
      reconnectAttempt: 0,
    },
    sessions: {},
    runs: {},
    messages: {},
    agentPresence: {},
  };
}

function upsertRun(state: RealtimeState, run: RealtimeRunEntity) {
  const existing = state.runs[run.runId];
  state.runs[run.runId] = existing
    ? {
        ...existing,
        ...run,
        messageIds: run.messageIds.length > 0 ? run.messageIds : existing.messageIds,
      }
    : run;
}

function upsertMessage(state: RealtimeState, message: RealtimeMessageEntity) {
  const existing = state.messages[message.messageId];
  if (!existing || message.revision >= existing.revision) {
    state.messages[message.messageId] = message;
  }
}

export function realtimeReducer(state: RealtimeState, event: RealtimeEvent): RealtimeState {
  const next: RealtimeState = {
    ...state,
    connection: { ...state.connection },
    sessions: { ...state.sessions },
    runs: { ...state.runs },
    messages: { ...state.messages },
    agentPresence: { ...state.agentPresence },
  };

  switch (event.type) {
    case 'connection.opened':
      next.connection.status = 'live';
      next.connection.lastLiveAt = event.receivedAt;
      next.connection.lastDisconnectReason = null;
      next.connection.reconcileNeeded = false;
      next.connection.reconnectAttempt = event.reconnectAttempt;
      return next;

    case 'connection.degraded':
      next.connection.status = 'degraded';
      next.connection.lastDisconnectReason = event.reason;
      return next;

    case 'connection.closed':
      next.connection.status = 'reconnecting';
      next.connection.lastDisconnectReason = event.reason;
      next.connection.reconnectAttempt = event.reconnectAttempt;
      return next;

    case 'connection.reconcile_requested':
      next.connection.status = 'reconnecting';
      next.connection.reconcileNeeded = true;
      next.connection.lastDisconnectReason = event.reason;
      return next;

    case 'session.upserted':
      next.sessions[event.session.sessionId] = event.session;
      return next;

    case 'run.created':
      upsertRun(next, {
        runId: event.runId,
        sessionId: event.sessionId,
        status: 'queued',
        messageIds: [],
        lastEventAt: event.receivedAt,
        finalized: false,
      });
      return next;

    case 'run.status_changed':
      upsertRun(next, {
        ...(next.runs[event.runId] ?? {
          runId: event.runId,
          sessionId: event.sessionId,
          messageIds: [],
        }),
        status: event.status,
        lastEventAt: event.receivedAt,
        finalized: event.finalized,
      } as RealtimeRunEntity);
      return next;

    case 'message.delta_applied':
      upsertMessage(next, {
        messageId: event.messageId,
        sessionId: event.sessionId,
        runId: event.runId,
        role: 'assistant',
        contentParts: [{ type: 'text', text: event.text }],
        status: 'streaming',
        revision: event.revision,
      });
      return next;

    case 'message.committed':
      upsertMessage(next, event.message);
      if (event.message.runId) {
        const run = next.runs[event.message.runId];
        if (run && !run.messageIds.includes(event.message.messageId)) {
          run.messageIds = [...run.messageIds, event.message.messageId];
        }
      }
      return next;

    case 'agent.presence_updated':
      next.agentPresence[event.sessionId] = event.presence;
      return next;

    case 'snapshot.loaded':
      next.sessions[event.snapshot.session.sessionId] = event.snapshot.session;
      for (const run of event.snapshot.runs) upsertRun(next, run);
      for (const message of event.snapshot.messages) upsertMessage(next, message);
      if (event.snapshot.agentPresence) {
        next.agentPresence[event.snapshot.session.sessionId] = event.snapshot.agentPresence;
      }
      next.connection.reconcileNeeded = false;
      next.connection.status = 'live';
      next.connection.lastLiveAt = event.snapshot.recoveredAt;
      return next;

    case 'snapshot.merge_completed':
      next.connection.reconcileNeeded = false;
      if (next.connection.status === 'reconnecting') next.connection.status = 'live';
      return next;
  }
}
