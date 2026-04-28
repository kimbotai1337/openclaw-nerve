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

function getSessionStateWatermark(state: RealtimeState, sessionId: string) {
  let watermark = state.sessions[sessionId]?.updatedAt ?? 0;

  for (const run of Object.values(state.runs)) {
    if (run.sessionId === sessionId && run.lastEventAt > watermark) watermark = run.lastEventAt;
  }

  for (const message of Object.values(state.messages)) {
    if (message.sessionId === sessionId && message.createdAt > watermark) watermark = message.createdAt;
  }

  const presence = state.agentPresence[sessionId];
  if (presence && presence.lastSeenAt > watermark) watermark = presence.lastSeenAt;

  return watermark;
}

function getSnapshotWatermark(snapshot: RealtimeSnapshotPayload) {
  let watermark = snapshot.session.updatedAt;

  for (const run of snapshot.runs) {
    if (run.lastEventAt > watermark) watermark = run.lastEventAt;
  }

  for (const message of snapshot.messages) {
    if (message.createdAt > watermark) watermark = message.createdAt;
  }

  if (snapshot.agentPresence && snapshot.agentPresence.lastSeenAt > watermark) {
    watermark = snapshot.agentPresence.lastSeenAt;
  }

  return watermark;
}

function hasSessionSlice(state: RealtimeState, sessionId: string) {
  if (state.sessions[sessionId] || state.agentPresence[sessionId]) return true;
  if (Object.values(state.runs).some((run) => run.sessionId === sessionId)) return true;
  return Object.values(state.messages).some((message) => message.sessionId === sessionId);
}

function isFreshSnapshot(state: RealtimeState, snapshot: RealtimeSnapshotPayload) {
  const sessionId = snapshot.session.sessionId;
  if (!hasSessionSlice(state, sessionId)) return true;

  const currentSession = state.sessions[sessionId];
  const currentWatermark = getSessionStateWatermark(state, sessionId);
  const snapshotWatermark = getSnapshotWatermark(snapshot);
  if (currentSession && snapshot.session.updatedAt < currentSession.updatedAt) return false;

  if (!currentSession && snapshotWatermark < currentWatermark) {
    return false;
  }

  if (
    currentSession &&
    snapshot.session.updatedAt === currentSession.updatedAt &&
    snapshot.session.sourceVersion === currentSession.sourceVersion &&
    snapshotWatermark < currentWatermark
  ) {
    return false;
  }

  return true;
}

function ensureRunForCommittedMessage(state: RealtimeState, message: RealtimeMessageEntity) {
  if (!message.runId) return;

  const run = state.runs[message.runId];
  if (!run) {
    state.runs[message.runId] = {
      runId: message.runId,
      sessionId: message.sessionId,
      status: 'unknown',
      messageIds: [message.messageId],
      lastEventAt: message.createdAt,
      finalized: false,
    };
    return;
  }

  if (run.messageIds.includes(message.messageId)) return;

  state.runs[message.runId] = {
    ...run,
    messageIds: [...run.messageIds, message.messageId],
  };
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
      next.connection.reconnectAttempt = event.reconnectAttempt;
      return next;

    case 'connection.offline':
      next.connection.status = 'offline';
      next.connection.lastDisconnectReason = event.reason;
      next.connection.reconnectAttempt = 0;
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
      next.connection.reconcileNeeded = true;
      return next;

    case 'session.upserted':
      next.sessions[event.session.sessionId] = event.session;
      return next;

    case 'run.created':
      if (next.runs[event.runId]) return next;

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
      if (next.runs[event.runId]?.finalized) return next;
      if (!event.finalized && (next.runs[event.runId]?.lastEventAt ?? -Infinity) > event.receivedAt) return next;

      upsertRun(next, {
        ...(next.runs[event.runId] ?? {
          runId: event.runId,
          sessionId: event.sessionId,
          messageIds: [],
          status: 'unknown',
          lastEventAt: 0,
          finalized: false,
        }),
        status: event.status,
        lastEventAt: Math.max(next.runs[event.runId]?.lastEventAt ?? 0, event.receivedAt),
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
      ensureRunForCommittedMessage(next, event.message);
      return next;

    case 'agent.presence_updated':
      next.agentPresence[event.presence.sessionId] = event.presence;
      return next;

    case 'snapshot.loaded':
      if (!isFreshSnapshot(next, event.snapshot)) return next;
      replaceSnapshotSessionState(next, event.snapshot);
      return next;

    case 'snapshot.merge_completed':
      next.connection.reconcileNeeded = false;
      return next;
  }
}
