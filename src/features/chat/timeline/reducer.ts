import type { ChatMsg, ToolGroupEntry } from '@/features/chat/types';
import { generateMsgId } from '@/features/chat/types';
import { renderMarkdown, renderToolResults } from '@/utils/helpers';
import {
  projectTranscriptMessages,
} from './projectTranscript';
import type {
  ChatTimelineItemKind,
  ChatRunTimelineState,
  ChatTimelineEvent,
  ChatTimelineItem,
  ChatTimelineState,
} from './types';

export function createChatTimelineState(sessionKey: string): ChatTimelineState {
  return {
    sessionKey,
    items: [],
    activeRuns: {},
    nextOrder: 0,
    lastGatewaySeq: null,
    lastSeqByRun: {},
  };
}

function cloneState(state: ChatTimelineState): ChatTimelineState {
  return {
    ...state,
    items: [...state.items],
    activeRuns: { ...state.activeRuns },
    lastSeqByRun: { ...state.lastSeqByRun },
  };
}

function nowOr(value: number | undefined): number {
  return Number.isFinite(value) ? value as number : Date.now();
}

function liveAssistantItemId(sessionKey: string, runId: string): string {
  return `live:${encodeURIComponent(sessionKey)}:${encodeURIComponent(runId)}:assistant`;
}

function liveToolItemId(sessionKey: string, runId: string, toolCallId: string): string {
  return `live:${encodeURIComponent(sessionKey)}:${encodeURIComponent(runId)}:tool:${encodeURIComponent(toolCallId)}`;
}

const DUPLICATE_MESSAGE_WINDOW_MS = 15_000;
const DUPLICATE_TOOL_WINDOW_MS = 60_000;

function normalizeMessageText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function normalizedAssistantText(msg: ChatMsg): string {
  return normalizeMessageText(msg.rawText);
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ');
}

function toolPreviewText(msg: ChatMsg): string {
  const grouped = msg.toolGroup?.map((entry) => entry.preview || entry.rawText).join(' ') || '';
  const primary = grouped || stripHtml(msg.html) || msg.rawText;
  return normalizeMessageText(primary);
}

function toolNames(msg: ChatMsg): Set<string> {
  const names = new Set<string>();
  const rawTexts = [
    msg.rawText,
    ...(msg.toolGroup?.map((entry) => entry.rawText) || []),
  ];
  for (const rawText of rawTexts) {
    for (const match of rawText.matchAll(/\*\*tool:\*\*\s+`([^`]+)`/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

function kindFromChatMsg(msg: ChatMsg): ChatTimelineItemKind {
  if (msg.isThinking) return 'thinking';
  if (msg.role === 'assistant') return 'assistant_message';
  if (msg.role === 'user') return 'user_message';
  if (msg.role === 'tool') return 'tool_call';
  if (msg.role === 'toolResult') return 'tool_result';
  return 'system_event';
}

function createAssistantChatMsg(text: string, timestamp: number, streaming: boolean): ChatMsg {
  return {
    msgId: generateMsgId(),
    role: 'assistant',
    html: renderToolResults(renderMarkdown(text)),
    rawText: text,
    timestamp: new Date(timestamp),
    streaming,
  };
}

function createToolChatMsg(params: {
  name: string;
  args: Record<string, unknown>;
  description: string;
  timestamp: number;
}): ChatMsg {
  const { name, args, description, timestamp } = params;
  return {
    msgId: generateMsgId(),
    role: 'tool',
    html: renderMarkdown(description),
    rawText: `**tool:** \`${name}\`\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``,
    timestamp: new Date(timestamp),
    streaming: false,
  };
}

function canGroupLiveToolItem(item: ChatTimelineItem): boolean {
  return (
    item.kind === 'tool_call' &&
    item.source === 'realtime' &&
    item.chatMsg.role === 'tool' &&
    !item.chatMsg.toolGroup?.length
  );
}

function liveToolGroupMessage(items: ChatTimelineItem[]): ChatMsg {
  const entries: ToolGroupEntry[] = items.map((item) => {
    const preview = toolPreviewText(item.chatMsg) || item.chatMsg.rawText.slice(0, 80);
    return {
      html: item.chatMsg.html,
      rawText: item.chatMsg.rawText,
      preview,
    };
  });
  const first = items[0];
  return {
    msgId: `live-tool-group:${items.map((item) => item.id).join('|')}`,
    role: 'tool',
    html: `Used ${entries.length} tools`,
    rawText: entries.map((entry) => entry.preview).join('\n'),
    timestamp: first.chatMsg.timestamp,
    streaming: false,
    toolGroup: entries,
  };
}

function selectGroupedTimelineMessages(items: ChatTimelineItem[]): ChatMsg[] {
  const messages: ChatMsg[] = [];
  let pendingTools: ChatTimelineItem[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      messages.push(pendingTools[0].chatMsg);
    } else {
      messages.push(liveToolGroupMessage(pendingTools));
    }
    pendingTools = [];
  };

  for (const item of items) {
    if (canGroupLiveToolItem(item)) {
      if (pendingTools.length === 0 || pendingTools[0].runId === item.runId) {
        pendingTools.push(item);
      } else {
        flushTools();
        pendingTools.push(item);
      }
      continue;
    }

    flushTools();
    messages.push(item.chatMsg);
  }

  flushTools();
  return messages;
}

function optimisticItemId(sessionKey: string, msg: ChatMsg): string {
  const localId = msg.tempId || msg.msgId || `${msg.role}:${msg.timestamp.getTime()}:${msg.rawText.slice(0, 80)}`;
  return `optimistic:${encodeURIComponent(sessionKey)}:${encodeURIComponent(localId)}`;
}

function hasInterveningUserMessage(
  state: ChatTimelineState,
  candidate: ChatTimelineItem,
  item: ChatTimelineItem,
): boolean {
  const candidateIndex = state.items.findIndex((existing) => existing.id === candidate.id);
  return state.items.some((existing, index) => {
    if (existing.kind !== 'user_message') return false;
    if (candidate.timestamp <= item.timestamp) {
      if (existing.timestamp > candidate.timestamp && existing.timestamp <= item.timestamp) return true;
      return candidateIndex >= 0 && existing.timestamp === candidate.timestamp && index > candidateIndex;
    }
    return existing.timestamp >= item.timestamp && existing.timestamp < candidate.timestamp;
  });
}

function equivalentMessageIndexExcept(
  state: ChatTimelineState,
  item: ChatTimelineItem,
  ignoredCandidateIds = new Set<string>(),
): number {
  const canCollapseAssistantFinal =
    item.kind === 'assistant_message' &&
    item.chatMsg.role === 'assistant' &&
    item.source === 'realtime' &&
    item.status === 'final';
  const canCollapseHistoryTranscript =
    item.source === 'history' &&
    item.status === 'final';
  const canCollapseHistoryUserWithOptimistic =
    canCollapseHistoryTranscript &&
    item.kind === 'user_message' &&
    item.chatMsg.role === 'user';
  const canCollapseHistoryAssistantWithRealtime =
    canCollapseHistoryTranscript &&
    item.kind === 'assistant_message' &&
    item.chatMsg.role === 'assistant';

  if (!canCollapseAssistantFinal && !canCollapseHistoryTranscript) return -1;

  const text = normalizedAssistantText(item.chatMsg);
  if (!text) return -1;

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  state.items.forEach((candidate, index) => {
    if (ignoredCandidateIds.has(candidate.id)) return;
    if (candidate.kind !== item.kind || candidate.chatMsg.role !== item.chatMsg.role) return;
    if (canCollapseAssistantFinal && candidate.status !== 'final') return;
    if (canCollapseHistoryTranscript) {
      if (candidate.source === 'history') {
        if (candidate.status !== 'final') return;
      } else if (canCollapseHistoryUserWithOptimistic && candidate.source === 'optimistic') {
        if (candidate.status !== 'pending' && candidate.status !== 'final') return;
        if (hasInterveningUserMessage(state, candidate, item)) return;
      } else if (canCollapseHistoryAssistantWithRealtime && candidate.source === 'realtime') {
        if (candidate.status !== 'final') return;
        if (hasInterveningUserMessage(state, candidate, item)) return;
      } else {
        return;
      }
    }
    if (
      canCollapseAssistantFinal &&
      candidate.runId &&
      item.runId &&
      candidate.runId !== item.runId
    ) return;
    if (normalizedAssistantText(candidate.chatMsg) !== text) return;
    if (canCollapseAssistantFinal && hasInterveningUserMessage(state, candidate, item)) return;

    const distance = Math.abs(candidate.timestamp - item.timestamp);
    if (distance <= DUPLICATE_MESSAGE_WINDOW_MS && distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });

  return bestIndex;
}

function hasEquivalentHistoryToolGroup(state: ChatTimelineState, item: ChatTimelineItem): boolean {
  if (item.kind !== 'tool_call' || item.chatMsg.role !== 'tool' || item.source !== 'realtime') {
    return false;
  }

  return state.items.some((candidate) => {
    if (candidate.source !== 'history') return false;
    return areEquivalentToolItems(state, candidate, item);
  });
}

function areEquivalentToolItems(
  state: ChatTimelineState,
  historyItem: ChatTimelineItem,
  realtimeItem: ChatTimelineItem,
): boolean {
  if (historyItem.kind !== 'tool_call' || historyItem.chatMsg.role !== 'tool') return false;
  if (realtimeItem.kind !== 'tool_call' || realtimeItem.chatMsg.role !== 'tool') return false;
  if (historyItem.source !== 'history' || realtimeItem.source !== 'realtime') return false;
  if (Math.abs(historyItem.timestamp - realtimeItem.timestamp) > DUPLICATE_TOOL_WINDOW_MS) return false;
  if (hasInterveningUserMessage(state, historyItem, realtimeItem)) return false;

  const historyNames = toolNames(historyItem.chatMsg);
  const realtimeNames = toolNames(realtimeItem.chatMsg);
  if ([...realtimeNames].some((name) => historyNames.has(name))) return true;

  const historyPreview = toolPreviewText(historyItem.chatMsg);
  const realtimePreview = toolPreviewText(realtimeItem.chatMsg);
  if (!historyPreview || !realtimePreview) return false;
  return historyPreview.includes(realtimePreview) || realtimePreview.includes(historyPreview);
}

function removeEquivalentRealtimeToolItemsForHistory(
  state: ChatTimelineState,
  item: ChatTimelineItem,
): void {
  if (item.kind !== 'tool_call' || item.chatMsg.role !== 'tool' || item.source !== 'history') return;
  state.items = state.items.filter((candidate) => !areEquivalentToolItems(state, item, candidate));
}

function upsertItem(
  state: ChatTimelineState,
  item: ChatTimelineItem,
  options: { ignoredEquivalentIds?: Set<string> } = {},
): ChatTimelineState {
  const next = cloneState(state);
  removeEquivalentRealtimeToolItemsForHistory(next, item);
  let existingIndex = next.items.findIndex((candidate) => candidate.id === item.id);
  if (existingIndex < 0 && hasEquivalentHistoryToolGroup(next, item)) {
    return next;
  }
  if (existingIndex < 0) {
    existingIndex = equivalentMessageIndexExcept(next, item, options.ignoredEquivalentIds);
  }

  if (existingIndex >= 0) {
    const existing = next.items[existingIndex];
    const timestamp = Math.min(existing.timestamp, item.timestamp);
    next.items[existingIndex] = {
      ...existing,
      ...item,
      id: existing.id,
      order: existing.order,
      timestamp,
      chatMsg: {
        ...item.chatMsg,
        msgId: existing.chatMsg.msgId || item.chatMsg.msgId,
        timestamp: new Date(timestamp),
      },
    };
    return next;
  }

  next.items.push({ ...item, order: next.nextOrder });
  next.nextOrder += 1;
  return next;
}

function removeItem(state: ChatTimelineState, id: string): ChatTimelineState {
  const next = cloneState(state);
  next.items = next.items.filter((item) => item.id !== id);
  return next;
}

function upsertRun(
  state: ChatTimelineState,
  event: Extract<ChatTimelineEvent, { runId: string }>,
  status: ChatRunTimelineState['status'],
): ChatTimelineState {
  const next = cloneState(state);
  const timestamp = nowOr(event.timestamp);
  const existing = next.activeRuns[event.runId];
  next.activeRuns[event.runId] = {
    runId: event.runId,
    sessionKey: event.sessionKey,
    status,
    startedAt: existing?.startedAt ?? timestamp,
    updatedAt: timestamp,
    stopReason: 'stopReason' in event ? event.stopReason : existing?.stopReason,
  };
  return next;
}

function mergeTranscriptItems(
  state: ChatTimelineState,
  items: ChatTimelineItem[],
): ChatTimelineState {
  let next = state;
  const mergedBatchIds = new Set<string>();
  for (const item of items) {
    next = upsertItem(next, item, { ignoredEquivalentIds: mergedBatchIds });
    mergedBatchIds.add(item.id);
  }
  return next;
}

export function reduceTimelineEvent(
  state: ChatTimelineState,
  event: ChatTimelineEvent,
): ChatTimelineState {
  if (event.sessionKey !== state.sessionKey) return state;

  if ('frameSeq' in event && typeof event.frameSeq === 'number') {
    state = { ...state, lastGatewaySeq: Math.max(state.lastGatewaySeq ?? event.frameSeq, event.frameSeq) };
  }

  if (event.type === 'history_snapshot') {
    return mergeTranscriptItems(state, projectTranscriptMessages({
      sessionKey: event.sessionKey,
      source: event.source,
      messages: event.messages,
      runId: event.runId,
    }));
  }

  if (event.type === 'optimistic_message') {
    const timestamp = nowOr(event.timestamp ?? event.chatMsg.timestamp.getTime());
    return upsertItem(state, {
      id: optimisticItemId(event.sessionKey, event.chatMsg),
      sessionKey: event.sessionKey,
      runId: event.runId,
      kind: kindFromChatMsg(event.chatMsg),
      source: event.source,
      status: event.chatMsg.failed ? 'error' : (event.chatMsg.pending ? 'pending' : 'final'),
      chatMsg: {
        ...event.chatMsg,
        timestamp: new Date(timestamp),
      },
      order: 0,
      timestamp,
    });
  }

  if (event.type === 'run_started') {
    return upsertRun(state, event, 'active');
  }

  if (event.type === 'assistant_delta') {
    const timestamp = nowOr(event.timestamp);
    const item: ChatTimelineItem = {
      id: liveAssistantItemId(event.sessionKey, event.runId),
      sessionKey: event.sessionKey,
      runId: event.runId,
      kind: 'assistant_message',
      source: event.source,
      status: 'streaming',
      chatMsg: createAssistantChatMsg(event.text, timestamp, true),
      order: 0,
      timestamp,
      seq: event.seq,
      frameSeq: event.frameSeq,
    };
    return upsertRun(upsertItem(state, item), event, 'active');
  }

  if (event.type === 'assistant_final') {
    let next = upsertRun(state, event, 'final');
    const projected = projectTranscriptMessages({
      sessionKey: event.sessionKey,
      source: 'realtime',
      messages: event.messages,
      runId: event.runId,
    });
    if (projected.some((item) => item.kind === 'assistant_message')) {
      next = removeItem(next, liveAssistantItemId(event.sessionKey, event.runId));
    }
    return mergeTranscriptItems(next, projected);
  }

  if (event.type === 'tool_started') {
    const timestamp = nowOr(event.timestamp);
    const item: ChatTimelineItem = {
      id: liveToolItemId(event.sessionKey, event.runId, event.toolCallId),
      sessionKey: event.sessionKey,
      runId: event.runId,
      toolCallId: event.toolCallId,
      kind: 'tool_call',
      source: event.source,
      status: 'running',
      chatMsg: createToolChatMsg({
        name: event.name,
        args: event.args,
        description: event.description || event.name,
        timestamp,
      }),
      order: 0,
      timestamp,
      seq: event.seq,
      frameSeq: event.frameSeq,
    };
    return upsertRun(upsertItem(state, item), event, 'active');
  }

  if (event.type === 'tool_result') {
    const next = cloneState(state);
    const id = liveToolItemId(event.sessionKey, event.runId, event.toolCallId);
    const existingIndex = next.items.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      const completedAt = nowOr(event.timestamp);
      next.items[existingIndex] = {
        ...next.items[existingIndex],
        status: 'completed',
        timestamp: completedAt,
        chatMsg: {
          ...next.items[existingIndex].chatMsg,
          timestamp: new Date(completedAt),
        },
      };
    }
    return upsertRun(next, event, 'active');
  }

  if (event.type === 'run_error') {
    return upsertRun(state, event, 'error');
  }

  if (event.type === 'run_aborted') {
    return upsertRun(state, event, 'aborted');
  }

  return state;
}

export function selectTimelineMessages(state: ChatTimelineState): ChatMsg[] {
  const sortedItems = [...state.items]
    .sort((a, b) => (a.timestamp - b.timestamp) || (a.order - b.order));
  return selectGroupedTimelineMessages(sortedItems);
}
