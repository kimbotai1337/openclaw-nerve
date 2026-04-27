import type { RealtimeMessageEntity, RealtimeRunStatus, RealtimeState, RealtimeUiStatus } from './types';

const ACTIVE_RUN_STATUSES = new Set<RealtimeRunStatus>(['queued', 'running']);
const TERMINAL_AGENT_PHASES = new Set([
  'aborted',
  'cancelled',
  'completed',
  'done',
  'end',
  'ended',
  'error',
  'final',
  'finished',
  'stopped',
  'timeout',
]);

function normalizeAgentPhase(phase: string | null | undefined) {
  return typeof phase === 'string' ? phase.trim().toLowerCase() : null;
}

export function isTerminalAgentPhase(phase: string | null | undefined) {
  const normalized = normalizeAgentPhase(phase);
  return normalized ? TERMINAL_AGENT_PHASES.has(normalized) : false;
}

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

export function selectSessionIsGenerating(state: RealtimeState, sessionId: string): boolean {
  const phase = normalizeAgentPhase(state.agentPresence[sessionId]?.phase);
  if (phase && phase !== 'idle' && !TERMINAL_AGENT_PHASES.has(phase)) {
    return true;
  }

  return Object.values(state.runs).some((run) =>
    run.sessionId === sessionId
    && !run.finalized
    && ACTIVE_RUN_STATUSES.has(run.status),
  );
}
