import type { ChatMessage, GatewayEvent } from '@/types';
import {
  classifyStreamEvent,
  extractFinalMessages,
  extractStreamDelta,
} from '@/features/chat/operations';
import type {
  RealtimeEvent,
  RealtimeMessageEntity,
  RealtimeSnapshotPayload,
} from './types';

function nowFromGatewayEvent(event: GatewayEvent): number {
  return typeof event.seq === 'number' ? event.seq : Date.now();
}

function extractMessageText(message: ChatMessage): string {
  if (typeof message.text === 'string' && message.text.length > 0) return message.text;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

function selectRenderableMessages(messages: ChatMessage[]): ChatMessage[] {
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  return assistantMessages.length > 0 ? assistantMessages : messages;
}

function parseTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function resolveCommittedCreatedAt(messages: ChatMessage[], fallback: number): number {
  const renderableMessages = selectRenderableMessages(messages);
  const timestamps = renderableMessages
    .map((message) => parseTimestamp(message.createdAt ?? message.timestamp ?? message.ts))
    .filter((value): value is number => value !== null);

  return timestamps.length > 0 ? Math.min(...timestamps) : fallback;
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

  const agentState = event.agentPayload?.state || event.agentPayload?.agentState;
  if (typeof agentState === 'string' && agentState.length > 0) return agentState;

  const lifecyclePhase = (event.agentPayload?.data as Record<string, unknown> | undefined)?.phase;
  if (typeof lifecyclePhase === 'string' && lifecyclePhase.length > 0) return lifecyclePhase;

  if (typeof event.agentPayload?.stream === 'string' && event.agentPayload.stream.length > 0) {
    return event.agentPayload.stream;
  }

  return null;
}

export function normalizeGatewayEvent(event: GatewayEvent): RealtimeEvent[] {
  const classified = classifyStreamEvent(event);
  if (!classified?.sessionKey) return [];

  const receivedAt = nowFromGatewayEvent(event);
  const sessionId = classified.sessionKey;

  if (classified.source === 'agent') {
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
          phase: deriveAgentPhase(classified),
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
    if (!delta) return [];

    return [
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
      {
        type: 'message.delta_applied',
        eventId: `chat:${receivedAt}:${classified.runId}:message`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        messageId: `${classified.runId}:assistant`,
        text: delta.cleaned,
        revision: classified.chatSeq ?? receivedAt,
      },
    ];
  }

  if (classified.type === 'chat_final' && classified.runId && classified.chatPayload) {
    const finalMessages = extractFinalMessages(classified.chatPayload);
    const renderableMessages = selectRenderableMessages(finalMessages);
    const assistantText = renderableMessages
      .map(extractMessageText)
      .join('\n')
      .trim();
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

    if (renderableMessages.length === 0) {
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
          assistantText,
          classified.chatSeq ?? receivedAt,
          resolveCommittedCreatedAt(renderableMessages, receivedAt),
        ),
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
