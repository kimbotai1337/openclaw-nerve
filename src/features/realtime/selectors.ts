import type { RealtimeMessageEntity, RealtimeState, RealtimeUiStatus } from './types';

export function selectRealtimeStatus(state: RealtimeState): RealtimeUiStatus {
  if (state.connection.reconcileNeeded) return 'syncing';
  if (state.connection.status === 'degraded') return 'degraded';
  if (state.connection.status === 'reconnecting' || state.connection.status === 'connecting') return 'reconnecting';
  if (state.connection.status === 'offline') return 'offline';
  return 'live';
}

export function selectVisibleMessagesForSession(state: RealtimeState, sessionId: string): RealtimeMessageEntity[] {
  return Object.values(state.messages)
    .filter((message) => message.sessionId === sessionId && message.status !== 'superseded')
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      if (left.revision !== right.revision) return left.revision - right.revision;
      return left.messageId.localeCompare(right.messageId);
    });
}

export function selectSessionAgentPresence(state: RealtimeState, sessionId: string) {
  return state.agentPresence[sessionId] ?? null;
}
