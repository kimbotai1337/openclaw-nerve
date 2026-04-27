import type { ChartData } from '@/features/charts/extractCharts';
import type { UploadAttachmentDescriptor } from '@/features/chat/types';

export type RealtimeSource = 'live-chat' | 'live-agent' | 'snapshot' | 'local';
export type RealtimeTransportStatus = 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'offline';
export type RealtimeUiStatus = 'live' | 'reconnecting' | 'syncing' | 'degraded' | 'offline';
export type ReconcileReason =
  | 'reconnect'
  | 'chat-gap'
  | 'frame-gap'
  | 'background-resume'
  | 'missing-run-activity'
  | 'subagent-complete'
  | 'session-switch';
export type RealtimeRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type RealtimeMessageStatus = 'streaming' | 'committed' | 'superseded';

export interface RealtimeConnectionState {
  status: RealtimeTransportStatus;
  lastLiveAt: number;
  lastDisconnectReason: string | null;
  reconcileNeeded: boolean;
  reconnectAttempt: number;
}

export interface RealtimeSessionEntity {
  sessionId: string;
  status: string;
  agentId: string | null;
  updatedAt: number;
  sourceVersion: string;
}

export interface RealtimeRunEntity {
  runId: string;
  sessionId: string;
  status: RealtimeRunStatus;
  messageIds: string[];
  lastEventAt: number;
  finalized: boolean;
}

export interface RealtimeMessagePart {
  type: 'text';
  text: string;
}

export interface RealtimeMessageEntity {
  messageId: string;
  sessionId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system';
  contentParts: RealtimeMessagePart[];
  charts?: ChartData[];
  uploadAttachments?: UploadAttachmentDescriptor[];
  status: RealtimeMessageStatus;
  revision: number;
  createdAt: number;
}

export interface RealtimeAgentPresence {
  sessionId: string;
  agentId: string | null;
  phase: string | null;
  lastSeenAt: number;
}

export interface RealtimeSnapshotPayload {
  session: RealtimeSessionEntity;
  runs: RealtimeRunEntity[];
  messages: RealtimeMessageEntity[];
  agentPresence: RealtimeAgentPresence | null;
  recoveredAt: number;
  source: 'server-reconcile';
}

export interface RealtimeState {
  connection: RealtimeConnectionState;
  sessions: Record<string, RealtimeSessionEntity>;
  runs: Record<string, RealtimeRunEntity>;
  messages: Record<string, RealtimeMessageEntity>;
  agentPresence: Record<string, RealtimeAgentPresence>;
}

interface RealtimeEventBase {
  eventId: string;
  receivedAt: number;
  source: RealtimeSource;
  sessionId: string;
}

export type RealtimeEvent =
  | (RealtimeEventBase & { type: 'connection.opened'; reconnectAttempt: number })
  | (RealtimeEventBase & { type: 'connection.degraded'; reason: string })
  | (RealtimeEventBase & { type: 'connection.closed'; reason: string; reconnectAttempt: number })
  | (RealtimeEventBase & { type: 'connection.reconcile_requested'; reason: ReconcileReason })
  | (RealtimeEventBase & { type: 'session.upserted'; session: RealtimeSessionEntity })
  | (RealtimeEventBase & { type: 'run.created'; runId: string })
  | (RealtimeEventBase & { type: 'run.status_changed'; runId: string; status: RealtimeRunStatus; finalized: boolean })
  | (RealtimeEventBase & { type: 'message.delta_applied'; runId: string; messageId: string; text: string; revision: number })
  | (RealtimeEventBase & { type: 'message.committed'; message: RealtimeMessageEntity })
  | (RealtimeEventBase & { type: 'agent.presence_updated'; presence: RealtimeAgentPresence })
  | (RealtimeEventBase & { type: 'snapshot.loaded'; snapshot: RealtimeSnapshotPayload })
  | (RealtimeEventBase & { type: 'snapshot.merge_completed' });
