import type { ChatMsg } from '@/features/chat/types';
import { generateMsgId } from '@/features/chat/types';
import { renderMarkdown, renderToolResults } from '@/utils/helpers';
import {
  projectTranscriptMessages,
} from './projectTranscript';
import type {
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

function upsertItem(state: ChatTimelineState, item: ChatTimelineItem): ChatTimelineState {
  const next = cloneState(state);
  const existingIndex = next.items.findIndex((candidate) => candidate.id === item.id);

  if (existingIndex >= 0) {
    const existing = next.items[existingIndex];
    next.items[existingIndex] = {
      ...existing,
      ...item,
      order: existing.order,
      chatMsg: {
        ...item.chatMsg,
        msgId: existing.chatMsg.msgId || item.chatMsg.msgId,
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
  for (const item of items) {
    next = upsertItem(next, item);
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
      next.items[existingIndex] = {
        ...next.items[existingIndex],
        status: 'completed',
        timestamp: nowOr(event.timestamp),
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
  return [...state.items]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.chatMsg);
}
