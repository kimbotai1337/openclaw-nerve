import type {
  RealtimeEvent,
  RealtimeMessageEntity,
  RealtimeRunEntity,
  RealtimeSnapshotPayload,
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
  state.runs[run.runId] = existing ? { ...existing, ...run } : run;
}

function messageStatusPriority(status: RealtimeMessageEntity['status']) {
  switch (status) {
    case 'streaming':
      return 0;
    case 'committed':
      return 1;
    case 'superseded':
      return 2;
  }
}

function upsertMessage(state: RealtimeState, message: RealtimeMessageEntity) {
  const existing = state.messages[message.messageId];
  if (!existing) {
    state.messages[message.messageId] = message;
    return;
  }

  if (message.revision < existing.revision) return;
  if (message.revision === existing.revision && messageStatusPriority(message.status) < messageStatusPriority(existing.status)) {
    return;
  }

  state.messages[message.messageId] = message;
}

function replaceSnapshotSessionState(state: RealtimeState, snapshot: RealtimeSnapshotPayload) {
  const sessionId = snapshot.session.sessionId;

  for (const [runId, run] of Object.entries(state.runs)) {
    if (run.sessionId === sessionId) delete state.runs[runId];
  }

  for (const [messageId, message] of Object.entries(state.messages)) {
    if (message.sessionId === sessionId) delete state.messages[messageId];
  }

  delete state.agentPresence[sessionId];

  state.sessions[sessionId] = snapshot.session;

  for (const run of snapshot.runs) {
    state.runs[run.runId] = run;
  }

  for (const message of snapshot.messages) {
    state.messages[message.messageId] = message;
  }

  if (snapshot.agentPresence) {
    state.agentPresence[sessionId] = snapshot.agentPresence;
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
        messageIds: next.runs[event.runId]?.messageIds ?? [],
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
        createdAt: next.messages[event.messageId]?.createdAt ?? event.receivedAt,
      });
      return next;

    case 'message.committed':
      upsertMessage(next, event.message);
      if (event.message.runId) {
        const run = next.runs[event.message.runId];
        if (run && !run.messageIds.includes(event.message.messageId)) {
          next.runs[event.message.runId] = {
            ...run,
            messageIds: [...run.messageIds, event.message.messageId],
          };
        }
      }
      return next;

    case 'agent.presence_updated':
      next.agentPresence[event.sessionId] = event.presence;
      return next;

    case 'snapshot.loaded':
      replaceSnapshotSessionState(next, event.snapshot);
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
