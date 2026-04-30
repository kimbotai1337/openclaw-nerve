/**
 * useChatMessages — Message CRUD, deduplication, normalization, and history
 *
 * Manages the full message buffer, visible window for infinite scroll,
 * history loading, and message merge/dedup utilities.
 */
import { useState, useRef, useCallback, useMemo } from 'react';
import { loadChatHistory } from '@/features/chat/operations';
import { generateMsgId } from '@/features/chat/types';
import type { ChatMsg } from '@/features/chat/types';

// ─── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_VISIBLE_COUNT = 50;
const LOAD_MORE_BATCH = 30;

// ─── Pure helpers (exported for testing / reuse) ────────────────────────────────

export function normalizeComparableText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function isLikelyDuplicateMessage(a: ChatMsg, b: ChatMsg): boolean {
  // Require timestamps within 60s to avoid suppressing legitimately repeated messages.
  const timeDiffMs = Math.abs(a.timestamp.getTime() - b.timestamp.getTime());
  if (timeDiffMs > 60_000) return false;

  // Compare extracted image URLs — same text with different images is NOT a duplicate.
  const aImgs = (a.extractedImages || []).map(i => i.url).sort().join('|');
  const bImgs = (b.extractedImages || []).map(i => i.url).sort().join('|');

  return (
    a.role === b.role &&
    normalizeComparableText(a.rawText) === normalizeComparableText(b.rawText) &&
    Boolean(a.isThinking) === Boolean(b.isThinking) &&
    (a.toolGroup?.length || 0) === (b.toolGroup?.length || 0) &&
    (a.images?.length || 0) === (b.images?.length || 0) &&
    aImgs === bImgs
  );
}

function isStreamingAssistantPrefixReplacement(existing: ChatMsg, incoming: ChatMsg): boolean {
  if (existing.role !== 'assistant' || incoming.role !== 'assistant') return false;
  if (!existing.streaming || incoming.streaming) return false;
  if (existing.pending || existing.failed || existing.toolGroup || existing.intermediate || existing.isThinking) {
    return false;
  }

  const existingText = normalizeComparableText(existing.rawText);
  const incomingText = normalizeComparableText(incoming.rawText);
  if (!existingText || !incomingText) return false;
  if (incomingText !== existingText && !incomingText.startsWith(existingText)) return false;

  // Scope replacement to the current turn; repeated short assistant replies in older turns must remain visible.
  const timeDiffMs = Math.abs(existing.timestamp.getTime() - incoming.timestamp.getTime());
  return timeDiffMs <= 5 * 60_000;
}

function isStableAssistantAnswer(message: ChatMsg): boolean {
  if (message.role !== 'assistant' || message.streaming) return false;
  if (message.pending || message.failed || message.toolGroup || message.intermediate || message.isThinking) {
    return false;
  }
  return normalizeComparableText(message.rawText).length > 0;
}

function isStaleStreamingAssistantPrefix(streaming: ChatMsg, finalAnswer: ChatMsg): boolean {
  if (streaming.role !== 'assistant' || !streaming.streaming) return false;
  if (!isStableAssistantAnswer(finalAnswer)) return false;

  const streamingText = normalizeComparableText(streaming.rawText);
  const finalText = normalizeComparableText(finalAnswer.rawText);
  if (!streamingText || !finalText) return false;
  if (finalText !== streamingText && !finalText.startsWith(streamingText)) return false;

  const timeDiffMs = Math.abs(streaming.timestamp.getTime() - finalAnswer.timestamp.getTime());
  return timeDiffMs <= 5 * 60_000;
}

function findStreamingAssistantPrefixReplacementIndex(
  messages: ChatMsg[],
  incoming: ChatMsg,
  claimedIndices?: Set<number>,
): number {
  if (incoming.role !== 'assistant') return -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role === 'user') break;
    if (claimedIndices?.has(index)) continue;
    if (isStreamingAssistantPrefixReplacement(candidate, incoming)) return index;
  }

  return -1;
}

function withMsgId(message: ChatMsg): ChatMsg {
  return message.msgId ? message : { ...message, msgId: generateMsgId() };
}

export function mergeFinalMessages(existing: ChatMsg[], incoming: ChatMsg[]): ChatMsg[] {
  if (incoming.length === 0) return existing;
  const merged = [...existing];

  for (const msg of incoming) {
    const last = merged[merged.length - 1];

    if (last && isLikelyDuplicateMessage(last, msg)) {
      merged[merged.length - 1] = msg;
      continue;
    }

    const streamingPrefixIndex = findStreamingAssistantPrefixReplacementIndex(merged, msg);
    if (streamingPrefixIndex >= 0) {
      merged.splice(streamingPrefixIndex, 1);
      merged.push(withMsgId(msg));
      continue;
    }

    // Avoid duplicating optimistic user bubbles if final payload repeats them.
    if (msg.role === 'user') {
      const recent = merged.slice(-6);
      const msgImgs = (msg.extractedImages || []).map(i => i.url).sort().join('|');
      const duplicateRecentUser = recent.some(
        (m) => {
          if (m.role !== 'user') return false;
          if (normalizeComparableText(m.rawText) !== normalizeComparableText(msg.rawText)) return false;
          const mImgs = (m.extractedImages || []).map(i => i.url).sort().join('|');
          return mImgs === msgImgs;
        },
      );
      if (duplicateRecentUser) continue;
    }

    merged.push(withMsgId(msg));
  }

  return merged;
}

export function patchThinkingDuration(messages: ChatMsg[], durationMs: number): ChatMsg[] {
  if (!durationMs || durationMs <= 0) return messages;

  const updated = [...messages];
  const lastUserIdx = updated.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

  for (let i = updated.length - 1; i > lastUserIdx; i--) {
    if (updated[i].role === 'assistant' && updated[i].isThinking) {
      updated[i] = { ...updated[i], thinkingDurationMs: durationMs };
      return updated;
    }
  }

  return messages;
}

function findRealtimeProjectionMatch(
  existingMessages: ChatMsg[],
  incomingMessage: ChatMsg,
  claimedIndices: Set<number>,
): number {
  if (incomingMessage.msgId) {
    const exactIndex = existingMessages.findIndex((message, index) =>
      !claimedIndices.has(index) && message.msgId === incomingMessage.msgId,
    );
    if (exactIndex >= 0) return exactIndex;
  }

  return existingMessages.findIndex((message, index) =>
    !claimedIndices.has(index) && isLikelyDuplicateMessage(message, incomingMessage),
  );
}

function hasCurrentTurnFinalAnswerReplacement(existingMessages: ChatMsg[], durableMessages: ChatMsg[], incomingMessage: ChatMsg): boolean {
  if (incomingMessage.role !== 'assistant' || !incomingMessage.streaming) return false;

  const lastUserIndex = existingMessages.reduce(
    (latest, message, index) => message.role === 'user' ? index : latest,
    -1,
  );
  const existingCurrentTurnFinals = existingMessages
    .slice(lastUserIndex + 1)
    .filter(isStableAssistantAnswer);
  if (existingCurrentTurnFinals.some((message) => isStaleStreamingAssistantPrefix(incomingMessage, message))) {
    return true;
  }

  const lastUser = lastUserIndex >= 0 ? existingMessages[lastUserIndex] : null;
  return durableMessages.some((message) =>
    message !== incomingMessage
    && (!lastUser || message.timestamp.getTime() >= lastUser.timestamp.getTime() - 1_000)
    && isStaleStreamingAssistantPrefix(incomingMessage, message),
  );
}

export function mergeRealtimeProjectedMessages(existingMessages: ChatMsg[], durableMessages: ChatMsg[]): ChatMsg[] {
  if (durableMessages.length === 0) return existingMessages;
  if (existingMessages.length === 0) {
    return durableMessages
      .filter((message) => !hasCurrentTurnFinalAnswerReplacement([], durableMessages, message))
      .map((message) => (message.msgId ? message : { ...message, msgId: generateMsgId() }));
  }

  const claimedIndices = new Set<number>();
  const replacements = new Map<number, ChatMsg>();
  const removedIndices = new Set<number>();
  const appendedMessages: ChatMsg[] = [];

  for (const durableMessage of durableMessages) {
    if (hasCurrentTurnFinalAnswerReplacement(existingMessages, durableMessages, durableMessage)) {
      continue;
    }

    const matchedIndex = findRealtimeProjectionMatch(existingMessages, durableMessage, claimedIndices);
    if (matchedIndex >= 0) {
      claimedIndices.add(matchedIndex);
      replacements.set(matchedIndex, durableMessage);
      continue;
    }

    const streamingPrefixIndex = findStreamingAssistantPrefixReplacementIndex(
      existingMessages,
      durableMessage,
      claimedIndices,
    );
    if (streamingPrefixIndex >= 0) {
      claimedIndices.add(streamingPrefixIndex);
      removedIndices.add(streamingPrefixIndex);
      appendedMessages.push(withMsgId(durableMessage));
      continue;
    }

    appendedMessages.push(withMsgId(durableMessage));
  }

  return [
    ...existingMessages
      .flatMap((message, index) => removedIndices.has(index) ? [] : [replacements.get(index) ?? message]),
    ...appendedMessages,
  ];
}

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatMessagesDeps {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  currentSessionRef: React.RefObject<string>;
}

export function useChatMessages({ rpc, currentSessionRef }: UseChatMessagesDeps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [, setVisibleCount] = useState(DEFAULT_VISIBLE_COUNT);
  const [hasMore, setHasMore] = useState(false);

  // Full history buffer + visible window for infinite scroll
  const allMessagesRef = useRef<ChatMsg[]>([]);
  const visibleCountRef = useRef(DEFAULT_VISIBLE_COUNT);

  /** Apply the windowed view of messages to React state. */
  const applyMessageWindow = useCallback((all: ChatMsg[], resetVisibleWindow = false) => {
    allMessagesRef.current = all;

    if (resetVisibleWindow) {
      const nextVisible = all.length <= DEFAULT_VISIBLE_COUNT ? all.length : DEFAULT_VISIBLE_COUNT;
      setVisibleCount(nextVisible);
      visibleCountRef.current = nextVisible;
      setHasMore(all.length > nextVisible);
      setMessages(all.slice(-nextVisible));
      return;
    }

    const currentVisible = all.length === 0
      ? 0
      : Math.max(DEFAULT_VISIBLE_COUNT, Math.min(visibleCountRef.current, all.length));
    setHasMore(all.length > currentVisible);
    setMessages(all.slice(-currentVisible));
  }, []);

  /** Load chat history from the gateway. */
  const loadHistory = useCallback(async (session?: string) => {
    const sk = session || currentSessionRef.current;
    try {
      const result = await loadChatHistory({ rpc, sessionKey: sk, limit: 500 });
      applyMessageWindow(result, true);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      allMessagesRef.current = [];
      setHasMore(false);
      setMessages(prev => [...prev, {
        msgId: generateMsgId(), role: 'system' as const, html: 'Failed to load history: ' + errMsg, rawText: '', timestamp: new Date(),
      }]);
    }
  }, [applyMessageWindow, currentSessionRef, rpc]);

  /** Load more (older) messages — returns true if there are still more to show. */
  const loadMore = useCallback(() => {
    const all = allMessagesRef.current;
    const currentVisible = visibleCountRef.current;
    if (all.length <= currentVisible) {
      setHasMore(false);
      return false;
    }

    const newCount = Math.min(all.length, currentVisible + LOAD_MORE_BATCH);
    setVisibleCount(newCount);
    visibleCountRef.current = newCount;
    setMessages(all.slice(-newCount));
    const stillMore = newCount < all.length;
    setHasMore(stillMore);
    return stillMore;
  }, []);

  /** Get all messages (full buffer, not just visible window). */
  const getAllMessages = useCallback(() => allMessagesRef.current, []);

  /** Set all messages buffer directly, or via functional updater for atomic read-then-write. */
  const setAllMessages = useCallback((updater: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])) => {
    allMessagesRef.current = typeof updater === 'function' ? updater(allMessagesRef.current) : updater;
  }, []);

  /** Reset message state (for session switch). */
  const resetMessageState = useCallback(() => {
    setMessages([]);
    setVisibleCount(DEFAULT_VISIBLE_COUNT);
    visibleCountRef.current = DEFAULT_VISIBLE_COUNT;
    setHasMore(false);
    allMessagesRef.current = [];
  }, []);

  return useMemo(() => ({
    messages,
    setMessages,
    hasMore,
    applyMessageWindow,
    loadHistory,
    loadMore,
    getAllMessages,
    setAllMessages,
    resetMessageState,
  }), [
    messages,
    hasMore,
    setMessages,
    applyMessageWindow,
    loadHistory,
    loadMore,
    getAllMessages,
    setAllMessages,
    resetMessageState,
  ]);
}
