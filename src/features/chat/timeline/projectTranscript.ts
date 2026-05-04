import type { ChatMsg, ChatMsgRole } from '@/features/chat/types';
import type { ChatMessage } from '@/types';
import { processChatMessages } from '@/features/chat/operations/loadHistory';
import type { ChatTimelineItem, ChatTimelineItemKind, TimelineSource } from './types';

function normalizeForId(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function timestampMs(msg: ChatMsg): number {
  const value = msg.timestamp.getTime();
  return Number.isFinite(value) ? value : 0;
}

function kindFromChatMsg(msg: ChatMsg): ChatTimelineItemKind {
  if (msg.isThinking) return 'thinking';
  if (msg.role === 'assistant') return 'assistant_message';
  if (msg.role === 'user') return 'user_message';
  if (msg.role === 'tool') return 'tool_call';
  if (msg.role === 'toolResult') return 'tool_result';
  return 'system_event';
}

function roleForId(role: ChatMsgRole): string {
  return role === 'toolResult' ? 'tool-result' : role;
}

export function transcriptItemId(params: {
  sessionKey: string;
  runId?: string;
  msg: ChatMsg;
  index?: number;
}): string {
  const { sessionKey, msg, index } = params;
  const timestamp = timestampMs(msg);
  const thinking = msg.isThinking ? 'thinking' : 'message';
  const text = normalizeForId(msg.rawText || msg.html || '');
  const grouped = msg.toolGroup?.length ? `group-${msg.toolGroup.length}` : 'single';
  return [
    'history',
    encodeURIComponent(sessionKey),
    roleForId(msg.role),
    thinking,
    grouped,
    timestamp,
    index ?? 0,
    encodeURIComponent(text),
  ].join(':');
}

export function projectTranscriptMessages(params: {
  sessionKey: string;
  source: Extract<TimelineSource, 'history' | 'realtime'>;
  messages: ChatMessage[];
  runId?: string;
}): ChatTimelineItem[] {
  const { sessionKey, source, messages, runId } = params;
  const chatMsgs = processChatMessages(messages, { sessionKey });

  return chatMsgs.map((chatMsg, index) => ({
    id: transcriptItemId({ sessionKey, runId, msg: chatMsg, index }),
    sessionKey,
    runId,
    kind: kindFromChatMsg(chatMsg),
    source,
    status: 'final' as const,
    chatMsg,
    order: index,
    timestamp: timestampMs(chatMsg),
  }));
}
