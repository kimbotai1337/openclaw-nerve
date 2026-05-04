import type { ChatMessage, GatewayEvent } from '@/types';
import {
  classifyStreamEvent,
  extractFinalMessages,
  extractStreamDelta,
} from '@/features/chat/operations/streamEventHandler';
import { describeToolUse } from '@/utils/helpers';
import type { ChatTimelineEvent } from './types';

function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function gatewayTimestamp(event: GatewayEvent): number | undefined {
  return eventTimestamp(event.ts);
}

function messageTimestamp(message: ChatMessage | string | undefined): number | undefined {
  if (!message || typeof message === 'string') return undefined;
  return eventTimestamp(message.timestamp)
    ?? eventTimestamp(message.createdAt)
    ?? eventTimestamp(message.ts);
}

function finalMessagesTimestamp(messages: ChatMessage[]): number | undefined {
  for (const message of [...messages].reverse()) {
    const timestamp = messageTimestamp(message);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

export function normalizeGatewayEvent(event: GatewayEvent): ChatTimelineEvent[] {
  const classified = classifyStreamEvent(event);
  if (!classified?.sessionKey) return [];

  const sessionKey = classified.sessionKey;
  const runId = classified.runId;
  if (!runId) return [];

  if (classified.source === 'chat') {
    const payload = classified.chatPayload!;
    const base = {
      sessionKey,
      runId,
      source: 'realtime' as const,
      seq: classified.chatSeq,
      frameSeq: classified.frameSeq,
    };

    if (classified.type === 'chat_started') {
      return [{ ...base, type: 'run_started', timestamp: gatewayTimestamp(event) ?? Date.now() }];
    }

    if (classified.type === 'chat_delta') {
      const delta = extractStreamDelta(payload);
      if (!delta?.cleaned.trim()) return [];
      return [{
        ...base,
        type: 'assistant_delta',
        text: delta.cleaned,
        timestamp: messageTimestamp(payload.message) ?? gatewayTimestamp(event) ?? Date.now(),
      }];
    }

    if (classified.type === 'chat_final') {
      const messages = extractFinalMessages(payload);
      return [{
        ...base,
        type: 'assistant_final',
        messages,
        stopReason: payload.stopReason,
        timestamp: finalMessagesTimestamp(messages) ?? gatewayTimestamp(event) ?? Date.now(),
      }];
    }

    if (classified.type === 'chat_error') {
      return [{
        ...base,
        type: 'run_error',
        error: payload.errorMessage || payload.error || 'Chat run failed',
        timestamp: gatewayTimestamp(event) ?? Date.now(),
      }];
    }

    if (classified.type === 'chat_aborted') {
      return [{
        ...base,
        type: 'run_aborted',
        stopReason: payload.stopReason,
        timestamp: gatewayTimestamp(event) ?? Date.now(),
      }];
    }
  }

  if (classified.source === 'agent') {
    const payload = classified.agentPayload!;
    const base = {
      sessionKey,
      runId,
      source: 'realtime' as const,
      seq: classified.chatSeq,
      frameSeq: classified.frameSeq,
      timestamp: eventTimestamp((payload as { ts?: unknown }).ts) ?? gatewayTimestamp(event) ?? Date.now(),
    };

    if (classified.type === 'lifecycle_start') {
      return [{ ...base, type: 'run_started' }];
    }

    if (classified.type === 'lifecycle_end') {
      const phase = (payload.data as { phase?: string } | undefined)?.phase;
      if (phase === 'error') {
        return [{
          ...base,
          type: 'run_error',
          error: 'Agent lifecycle ended with an error',
        }];
      }
      return [];
    }

    if (classified.type === 'agent_tool_start') {
      const data = payload.data!;
      const args = data.args || {};
      const description = typeof data.title === 'string' && data.title.trim()
        ? data.title
        : (describeToolUse(data.name!, args) || data.name!);
      return [{
        ...base,
        type: 'tool_started',
        toolCallId: data.toolCallId!,
        name: data.name!,
        args,
        description,
      }];
    }

    if (classified.type === 'agent_tool_result') {
      return [{
        ...base,
        type: 'tool_result',
        toolCallId: payload.data!.toolCallId!,
      }];
    }
  }

  return [];
}
