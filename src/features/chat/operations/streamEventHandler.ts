/**
 * streamEventHandler — Pure parsing helpers for live gateway events.
 *
 * This module stays focused on classifying raw frames and extracting payload data.
 * Reducer-facing normalization belongs in the realtime layer.
 */
import type {
  GatewayEvent,
  ChatEventPayload,
  AgentEventPayload,
  ChatMessage,
  ContentBlock,
} from '@/types';
import type { ActivityLogEntry, ProcessingStage } from '@/contexts/ChatContext';
import { extractText, describeToolUse } from '@/utils/helpers';
import { extractTTSMarkers } from '@/features/tts/useTTS';
import { extractChartMarkers } from '@/features/charts/extractCharts';
import type { ChartData } from '@/features/charts/extractCharts';

// ─── Agent states that indicate active processing ──────────────────────────────
const ACTIVE_STATES = new Set([
  'thinking', 'processing', 'tool_use', 'executing', 'tool', 'started', 'delta',
]);

/** Check if an agent state indicates active processing (for mid-stream join detection). */
export function isActiveAgentState(state: string): boolean {
  return ACTIVE_STATES.has(state);
}

// ─── Stream event classification ───────────────────────────────────────────────

export type StreamEventType =
  | 'lifecycle_start'
  | 'lifecycle_end'
  | 'assistant_stream'
  | 'agent_tool_start'
  | 'agent_tool_result'
  | 'agent_state'
  | 'chat_started'
  | 'chat_delta'
  | 'chat_final'
  | 'chat_error'
  | 'chat_aborted'
  | 'ignore';

export interface ClassifiedEvent {
  type: StreamEventType;
  /** Original gateway event type ('agent' | 'chat') */
  source: 'agent' | 'chat';
  /** Session key from the payload */
  sessionKey?: string;
  /** Chat/agent run id (if present) */
  runId?: string;
  /** Chat payload sequence (if present) */
  chatSeq?: number;
  /** Gateway frame sequence (if present) */
  frameSeq?: number;
  /** Agent payload (when source === 'agent') */
  agentPayload?: AgentEventPayload;
  /** Chat payload (when source === 'chat') */
  chatPayload?: ChatEventPayload;
}

/**
 * Classify a raw gateway event into a typed stream event.
 * Returns `null` if the event is not chat/agent related.
 */
export function classifyStreamEvent(event: GatewayEvent): ClassifiedEvent | null {
  const evt = event.event;

  if (evt === 'agent') {
    const ap = (event.payload || {}) as AgentEventPayload;
    const runId = typeof (ap as { runId?: unknown }).runId === 'string'
      ? (ap as { runId: string }).runId
      : undefined;
    const chatSeq = typeof (ap as { seq?: unknown }).seq === 'number'
      ? (ap as { seq: number }).seq
      : undefined;

    const base = {
      source: 'agent' as const,
      sessionKey: ap.sessionKey,
      runId,
      chatSeq,
      frameSeq: event.seq,
      agentPayload: ap,
    };

    // Lifecycle events from CLI agents (Codex, Claude Code CLI)
    if (ap.stream === 'lifecycle') {
      const phase = (ap.data as Record<string, unknown> | undefined)?.phase;
      if (phase === 'start') return { ...base, type: 'lifecycle_start' };
      if (phase === 'end' || phase === 'error') return { ...base, type: 'lifecycle_end' };
      return { ...base, type: 'ignore' };
    }

    // Assistant stream events from CLI agents
    if (ap.stream === 'assistant') {
      return { ...base, type: 'assistant_stream' };
    }

    // Real-time tool event streaming
    if (ap.stream === 'tool') {
      const data = ap.data;
      if (!data) return { ...base, type: 'ignore' };
      if (data.phase === 'start' && data.name && data.toolCallId) {
        return { ...base, type: 'agent_tool_start' };
      }
      if (data.phase === 'result' && data.toolCallId) {
        return { ...base, type: 'agent_tool_result' };
      }
      return { ...base, type: 'ignore' };
    }

    // Agent state changes (thinking, tool_use, etc.)
    const agentState = ap.state || ap.agentState;
    if (agentState) {
      return { ...base, type: 'agent_state' };
    }

    return { ...base, type: 'ignore' };
  }

  if (evt === 'chat') {
    const cp = (event.payload || {}) as ChatEventPayload;
    const base = {
      source: 'chat' as const,
      sessionKey: cp.sessionKey,
      runId: cp.runId,
      chatSeq: cp.seq,
      frameSeq: event.seq,
      chatPayload: cp,
    };
    const state = cp.state;

    if (state === 'started') return { ...base, type: 'chat_started' };
    if (state === 'delta') return { ...base, type: 'chat_delta' };
    if (state === 'final') return { ...base, type: 'chat_final' };
    if (state === 'aborted') return { ...base, type: 'chat_aborted' };
    if (state === 'error') return { ...base, type: 'chat_error' };

    return { ...base, type: 'ignore' };
  }

  return null;
}

// ─── Delta extraction ──────────────────────────────────────────────────────────

/**
 * Extract the streaming text delta from a chat delta event.
 * Returns null if no text content is present.
 */
export function extractStreamDelta(
  chatPayload: ChatEventPayload,
): { text: string; cleaned: string; ttsText: string | null; charts: ChartData[] } | null {
  if (chatPayload.state !== 'delta') return null;
  if (!chatPayload.message || typeof chatPayload.message === 'string') return null;

  const deltaText = extractText(chatPayload.message);
  if (deltaText === undefined) return null;

  const { cleaned: ttsStripped, ttsText } = extractTTSMarkers(deltaText);
  const { cleaned, charts } = extractChartMarkers(ttsStripped);
  return { text: deltaText, cleaned, ttsText, charts };
}

// ─── Final message extraction ──────────────────────────────────────────────────

export interface FinalMessageData {
  message: ChatMessage;
  text: string;
  ttsText: string | null;
  charts: ChartData[];
}

function createSyntheticAssistantMessage(content: string | ContentBlock[]): ChatMessage {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

function normalizeFinalMessageCandidate(message: ChatMessage | string | undefined): ChatMessage | null {
  if (!message) return null;
  if (typeof message === 'string') {
    return createSyntheticAssistantMessage(message);
  }
  return message;
}

function extractAssistantTextContent(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;

  if (typeof message.content === 'string') {
    const normalized = message.content.trim();
    return normalized || null;
  }

  if (Array.isArray(message.content)) {
    const normalized = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text?.trim() || '')
      .filter(Boolean)
      .join('\n')
      .trim();
    return normalized || null;
  }

  const normalized = message.text?.trim() || '';
  return normalized || null;
}

function normalizeAssistantText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function hasLaterAssistantTextReplacement(
  messages: ChatMessage[],
  startIndex: number,
  assistantText: string,
  allowPrefixReplacement: boolean,
): boolean {
  const normalizedCurrent = normalizeAssistantText(assistantText);
  if (!normalizedCurrent) return false;

  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const laterAssistantText = extractAssistantTextContent(messages[index]);
    if (!laterAssistantText) continue;

    const normalizedLater = normalizeAssistantText(laterAssistantText);
    if (normalizedLater === normalizedCurrent) {
      return true;
    }
    if (
      allowPrefixReplacement
      && normalizedLater.length > normalizedCurrent.length
      && normalizedLater.startsWith(normalizedCurrent)
    ) {
      return true;
    }
  }

  return false;
}

function hasNonTextAssistantTranscriptContent(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((block) => block.type !== 'text');
}

function stripAssistantTextFromMessage(message: ChatMessage): ChatMessage | null {
  if (message.role !== 'assistant') return message;

  if (typeof message.content === 'string') {
    return null;
  }

  if (Array.isArray(message.content)) {
    const nonTextContent = message.content.filter((block) => block.type !== 'text');
    if (nonTextContent.length === 0) return null;
    return {
      ...message,
      content: nonTextContent,
    };
  }

  if (typeof message.text === 'string' && message.text.trim().length > 0) {
    return null;
  }

  return message;
}

function pruneRedundantAssistantPrefixMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message, index) => {
    const assistantText = extractAssistantTextContent(message);
    if (!assistantText) return [message];
    if (!hasLaterAssistantTextReplacement(
      messages,
      index,
      assistantText,
      hasNonTextAssistantTranscriptContent(message),
    )) return [message];

    const strippedMessage = stripAssistantTextFromMessage(message);
    return strippedMessage ? [strippedMessage] : [];
  });
}

function appendUniqueAssistantTextMessages(
  messages: ChatMessage[],
  candidates: Array<ChatMessage | null>,
): ChatMessage[] {
  const result = [...messages];
  const seenAssistantText = new Set(
    result
      .map(extractAssistantTextContent)
      .filter((text): text is string => Boolean(text))
      .map((text) => normalizeAssistantText(text))
      .filter(Boolean),
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    const assistantText = extractAssistantTextContent(candidate);
    const normalizedAssistantText = assistantText ? normalizeAssistantText(assistantText) : '';
    if (!normalizedAssistantText || seenAssistantText.has(normalizedAssistantText)) continue;
    result.push(candidate);
    seenAssistantText.add(normalizedAssistantText);
  }

  return result;
}

/**
 * Extract all final messages from a chat 'final' event.
 * Supports payload.messages[], payload.message, and payload.content.
 */
export function extractFinalMessages(chatPayload: ChatEventPayload): ChatMessage[] {
  const messageCandidate = normalizeFinalMessageCandidate(chatPayload.message);
  const contentCandidate = Array.isArray(chatPayload.content) && chatPayload.content.length > 0
    ? createSyntheticAssistantMessage(chatPayload.content)
    : null;

  if (Array.isArray(chatPayload.messages) && chatPayload.messages.length > 0) {
    return pruneRedundantAssistantPrefixMessages(
      appendUniqueAssistantTextMessages(chatPayload.messages, [messageCandidate, contentCandidate]),
    );
  }

  if (messageCandidate) {
    return [messageCandidate];
  }

  if (contentCandidate) {
    return [contentCandidate];
  }

  return [];
}

/**
 * Extract a representative final assistant message and TTS text from a chat 'final' event.
 * Returns null if no renderable message is present.
 */
export function extractFinalMessage(chatPayload: ChatEventPayload): FinalMessageData | null {
  const messages = extractFinalMessages(chatPayload);
  if (messages.length === 0) return null;

  const representative = [...messages].reverse().find(m => m.role === 'assistant') || messages[messages.length - 1];
  const rawText = extractText(representative) || '';
  const { cleaned: ttsStripped, ttsText } = extractTTSMarkers(rawText);
  const { cleaned, charts } = extractChartMarkers(ttsStripped);
  return { message: representative, text: cleaned, ttsText, charts };
}

// ─── Activity log helpers ──────────────────────────────────────────────────────

/**
 * Build an ActivityLogEntry from an agent tool-start event.
 * Returns null if the event data is insufficient.
 */
export function buildActivityLogEntry(agentPayload: AgentEventPayload): ActivityLogEntry | null {
  const data = agentPayload.data;
  if (!data || data.phase !== 'start' || !data.name || !data.toolCallId) return null;

  const desc = describeToolUse(data.name, data.args || {}) || data.name;

  return {
    id: data.toolCallId,
    toolName: data.name,
    description: desc,
    startedAt: Date.now(),
    phase: 'running',
  };
}

/**
 * Mark a tool as completed in the activity log (returns a new array).
 */
export function markToolCompleted(
  log: ActivityLogEntry[],
  toolCallId: string,
): ActivityLogEntry[] {
  return log.map(e =>
    e.id === toolCallId
      ? { ...e, phase: 'completed' as const, completedAt: Date.now() }
      : e,
  );
}

/**
 * Append a new entry to the activity log, capping at maxEntries.
 */
export function appendActivityEntry(
  log: ActivityLogEntry[],
  entry: ActivityLogEntry,
  maxEntries = 6,
): ActivityLogEntry[] {
  const next = [...log, entry];
  return next.length > maxEntries ? next.slice(-maxEntries) : next;
}

// ─── Processing stage derivation ───────────────────────────────────────────────

/**
 * Derive the processing stage from an agent state string.
 */
export function deriveProcessingStage(agentState: string): ProcessingStage {
  if (agentState === 'thinking' || agentState === 'processing') return 'thinking';
  if (agentState === 'tool_use' || agentState === 'executing' || agentState === 'tool') return 'tool_use';
  return null;
}
