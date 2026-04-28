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

let lastFallbackRevisionBase = -1;
let fallbackRevisionOffset = 0;
let fallbackRunSequence = 0;
const activeChatRunIdsBySession = new Map<string, string>();

function nextFallbackRevisionOffset(receivedAt: number): number {
  if (receivedAt !== lastFallbackRevisionBase) {
    lastFallbackRevisionBase = receivedAt;
    fallbackRevisionOffset = 0;
    return fallbackRevisionOffset;
  }

  fallbackRevisionOffset += 1;
  return fallbackRevisionOffset;
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

function resolveEventOrdering(
  event: NonNullable<ReturnType<typeof classifyStreamEvent>>,
  receivedAt: number,
): { revision: number; fallbackKey: string | null } {
  if (typeof event.chatSeq === 'number' && Number.isFinite(event.chatSeq)) {
    return { revision: event.chatSeq, fallbackKey: null };
  }

  if (typeof event.frameSeq === 'number' && Number.isFinite(event.frameSeq)) {
    return { revision: event.frameSeq, fallbackKey: null };
  }

  const offset = nextFallbackRevisionOffset(receivedAt);
  return {
    revision: receivedAt * 1000 + offset,
    fallbackKey: `fallback-${receivedAt}-${offset}`,
  };
}

function buildChatEventId(receivedAt: number, runId: string, suffix: string, fallbackKey: string | null): string {
  return fallbackKey
    ? `chat:${receivedAt}:${runId}:${suffix}:${fallbackKey}`
    : `chat:${receivedAt}:${runId}:${suffix}`;
}

function createFallbackRunId(sessionId: string): string {
  fallbackRunSequence += 1;
  return `run-fallback:${sessionId}:${fallbackRunSequence}`;
}

function resolveRealtimeRunId(
  event: NonNullable<ReturnType<typeof classifyStreamEvent>>,
  sessionId: string,
): string {
  if (event.source !== 'chat') {
    return event.runId ?? createFallbackRunId(sessionId);
  }

  const activeRunId = activeChatRunIdsBySession.get(sessionId) ?? null;
  const explicitRunId = event.runId ?? null;
  const isTerminal = event.type === 'chat_final'
    || event.type === 'chat_error'
    || event.type === 'chat_aborted';
  const isActiveTurnEvent = event.type === 'chat_started' || event.type === 'chat_delta';

  const resolvedRunId = explicitRunId ?? activeRunId ?? createFallbackRunId(sessionId);

  if (isTerminal) {
    activeChatRunIdsBySession.delete(sessionId);
  } else if (isActiveTurnEvent) {
    activeChatRunIdsBySession.set(sessionId, resolvedRunId);
  }

  return resolvedRunId;
}

export function resetRealtimeNormalizationStateForTests(): void {
  lastFallbackRevisionBase = -1;
  fallbackRevisionOffset = 0;
  fallbackRunSequence = 0;
  activeChatRunIdsBySession.clear();
}

function toCommittedMessage(
  sessionId: string,
  runId: string | null,
  messageId: string,
  text: string,
  charts: RealtimeMessageEntity['charts'],
  revision: number,
  createdAt: number,
): RealtimeMessageEntity {
  return {
    messageId,
    sessionId,
    runId,
    role: 'assistant',
    contentParts: text.length > 0 ? [{ type: 'text', text }] : [],
    ...(charts && charts.length > 0 ? { charts } : {}),
    status: 'committed',
    revision,
    createdAt,
  };
}

function deriveAgentPhase(event: ReturnType<typeof classifyStreamEvent>): string | null {
  if (!event || event.source !== 'agent') return null;

  if (event.type === 'assistant_stream') {
    return 'streaming';
  }

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

  if (classified.type === 'chat_started') {
    const runId = resolveRealtimeRunId(classified, sessionId);
    const ordering = resolveEventOrdering(classified, receivedAt);
    return [
      {
        type: 'run.status_changed',
        eventId: buildChatEventId(receivedAt, runId, 'started', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId,
        status: 'running',
        finalized: false,
      },
    ];
  }

  if (classified.type === 'chat_delta' && classified.chatPayload) {
    const runId = resolveRealtimeRunId(classified, sessionId);
    const delta = extractStreamDelta(classified.chatPayload);
    const ordering = resolveEventOrdering(classified, receivedAt);
    const events: RealtimeEvent[] = [
      {
        type: 'run.status_changed',
        eventId: buildChatEventId(receivedAt, runId, 'delta', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId,
        status: 'running',
        finalized: false,
      },
    ];

    if (delta) {
      events.push({
        type: 'message.delta_applied',
        eventId: buildChatEventId(receivedAt, runId, 'message', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId,
        messageId: `${runId}:assistant`,
        text: delta.cleaned,
        revision: ordering.revision,
      });
    }

    return events;
  }

  if (classified.type === 'chat_final' && classified.chatPayload) {
    const runId = resolveRealtimeRunId(classified, sessionId);
    const finalMessage = extractFinalMessage(classified.chatPayload);
    const ordering = resolveEventOrdering(classified, receivedAt);
    const runStatusEvent: RealtimeEvent = {
      type: 'run.status_changed',
      eventId: buildChatEventId(receivedAt, runId, 'final', ordering.fallbackKey),
      receivedAt,
      source: 'live-chat',
      sessionId,
      runId,
      status: 'completed',
      finalized: true,
    };

    if (
      !finalMessage ||
      finalMessage.message.role !== 'assistant' ||
      (finalMessage.text.trim().length === 0 && finalMessage.charts.length === 0)
    ) {
      return [runStatusEvent];
    }

    return [
      runStatusEvent,
      {
        type: 'message.committed',
        eventId: buildChatEventId(receivedAt, runId, 'committed', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        message: toCommittedMessage(
          sessionId,
          runId,
          `${runId}:assistant`,
          finalMessage.text,
          finalMessage.charts,
          ordering.revision,
          resolveCommittedCreatedAt(finalMessage.message, receivedAt),
        ),
      },
    ];
  }

  if (classified.type === 'chat_error') {
    const runId = resolveRealtimeRunId(classified, sessionId);
    const ordering = resolveEventOrdering(classified, receivedAt);
    return [
      {
        type: 'run.status_changed',
        eventId: buildChatEventId(receivedAt, runId, 'error', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId,
        status: 'failed',
        finalized: true,
      },
    ];
  }

  if (classified.type === 'chat_aborted') {
    const runId = resolveRealtimeRunId(classified, sessionId);
    const ordering = resolveEventOrdering(classified, receivedAt);
    return [
      {
        type: 'run.status_changed',
        eventId: buildChatEventId(receivedAt, runId, 'aborted', ordering.fallbackKey),
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId,
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
