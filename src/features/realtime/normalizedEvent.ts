import type { ChatMessage, GatewayEvent } from '@/types';
import {
  classifyStreamEvent,
  extractFinalMessage,
  extractStreamDelta,
} from '@/features/chat/operations';
import type {
  RealtimeEvent,
  RealtimeMessageEntity,
  RealtimeSnapshotPayload,
} from './types';

function nowFromGatewayEvent(): number {
  return Date.now();
}

function parseTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function resolveCommittedCreatedAt(message: ChatMessage, fallback: number): number {
  return parseTimestamp(message.createdAt ?? message.timestamp ?? message.ts) ?? fallback;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveMessageRevision(
  event: NonNullable<ReturnType<typeof classifyStreamEvent>>,
  receivedAt: number,
): number {
  return event.chatSeq ?? event.frameSeq ?? receivedAt;
}

function toCommittedMessage(
  sessionId: string,
  runId: string | null,
  messageId: string,
  text: string,
  revision: number,
  createdAt: number,
): RealtimeMessageEntity {
  return {
    messageId,
    sessionId,
    runId,
    role: 'assistant',
    contentParts: [{ type: 'text', text }],
    status: 'committed',
    revision,
    createdAt,
  };
}

function deriveAgentPhase(event: ReturnType<typeof classifyStreamEvent>): string | null {
  if (!event || event.source !== 'agent') return null;

  const agentState = trimToNull(event.agentPayload?.state) ?? trimToNull(event.agentPayload?.agentState);
  if (agentState) return agentState;

  if (event.type === 'lifecycle_start' || event.type === 'lifecycle_end') {
    const lifecyclePhase = trimToNull(
      (event.agentPayload?.data as Record<string, unknown> | undefined)?.phase,
    );
    if (lifecyclePhase) return lifecyclePhase;
  }

  return null;
}

export function normalizeGatewayEvent(event: GatewayEvent): RealtimeEvent[] {
  const classified = classifyStreamEvent(event);
  if (!classified?.sessionKey) return [];

  const receivedAt = nowFromGatewayEvent();
  const sessionId = classified.sessionKey;

  if (classified.source === 'agent') {
    const phase = deriveAgentPhase(classified);
    if (!phase) return [];

    return [
      {
        type: 'agent.presence_updated',
        eventId: `agent:${receivedAt}:${sessionId}`,
        receivedAt,
        source: 'live-agent',
        sessionId,
        presence: {
          sessionId,
          agentId: sessionId.split(':')[1] || null,
          phase,
          lastSeenAt: receivedAt,
        },
      },
    ];
  }

  if (classified.type === 'chat_started' && classified.runId) {
    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:started`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'running',
        finalized: false,
      },
    ];
  }

  if (classified.type === 'chat_delta' && classified.runId && classified.chatPayload) {
    const delta = extractStreamDelta(classified.chatPayload);
    const revision = resolveMessageRevision(classified, receivedAt);
    const events: RealtimeEvent[] = [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:delta`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'running',
        finalized: false,
      },
    ];

    if (delta) {
      events.push({
        type: 'message.delta_applied',
        eventId: `chat:${receivedAt}:${classified.runId}:message`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        messageId: `${classified.runId}:assistant`,
        text: delta.cleaned,
        revision,
      });
    }

    return events;
  }

  if (classified.type === 'chat_final' && classified.runId && classified.chatPayload) {
    const finalMessage = extractFinalMessage(classified.chatPayload);
    const revision = resolveMessageRevision(classified, receivedAt);
    const runStatusEvent: RealtimeEvent = {
      type: 'run.status_changed',
      eventId: `chat:${receivedAt}:${classified.runId}:final`,
      receivedAt,
      source: 'live-chat',
      sessionId,
      runId: classified.runId,
      status: 'completed',
      finalized: true,
    };

    if (
      !finalMessage ||
      finalMessage.message.role !== 'assistant' ||
      finalMessage.text.trim().length === 0
    ) {
      return [runStatusEvent];
    }

    return [
      runStatusEvent,
      {
        type: 'message.committed',
        eventId: `chat:${receivedAt}:${classified.runId}:committed`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        message: toCommittedMessage(
          sessionId,
          classified.runId,
          `${classified.runId}:assistant`,
          finalMessage.text,
          revision,
          resolveCommittedCreatedAt(finalMessage.message, receivedAt),
        ),
      },
    ];
  }

  if (classified.type === 'chat_error' && classified.runId) {
    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:error`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'failed',
        finalized: true,
      },
    ];
  }

  if (classified.type === 'chat_aborted' && classified.runId) {
    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:aborted`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'interrupted',
        finalized: true,
      },
    ];
  }

  return [];
}

export function normalizeLocalRunCreated(
  sessionId: string,
  runId: string,
  receivedAt: number,
): RealtimeEvent {
  return {
    type: 'run.created',
    eventId: `local:${runId}:${receivedAt}`,
    receivedAt,
    source: 'local',
    sessionId,
    runId,
  };
}

export function normalizeSnapshotLoaded(snapshot: RealtimeSnapshotPayload): RealtimeEvent {
  return {
    type: 'snapshot.loaded',
    eventId: `snapshot:${snapshot.session.sessionId}:${snapshot.recoveredAt}`,
    receivedAt: snapshot.recoveredAt,
    source: 'snapshot',
    sessionId: snapshot.session.sessionId,
    snapshot,
  };
}
