import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatMessage, GatewayEvent } from '@/types';
import type { ChatMsg } from '@/features/chat/types';
import { ChatTimelineStore } from './chatTimelineStore';

export interface UseChatTimelineApi {
  messages: ChatMsg[];
  ingestGatewayEvent: (event: GatewayEvent) => void;
  hydrateHistory: (messages: ChatMessage[]) => void;
  reset: () => void;
}

export function useChatTimeline(sessionKey: string): UseChatTimelineApi {
  const [store] = useState(() => new ChatTimelineStore());
  const listenersRef = useRef(new Set<() => void>());

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => {
    if (!sessionKey) return '';
    const state = store.getState(sessionKey);
    return `${state.items.length}:${state.nextOrder}:${state.lastGatewaySeq ?? 0}`;
  }, [sessionKey, store]);

  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const ingestGatewayEvent = useCallback((event: GatewayEvent) => {
    store.ingestGatewayEvent(event);
    notify();
  }, [notify, store]);

  const hydrateHistory = useCallback((messages: ChatMessage[]) => {
    if (!sessionKey) return;
    store.hydrateHistory(sessionKey, messages);
    notify();
  }, [notify, sessionKey, store]);

  const reset = useCallback(() => {
    if (!sessionKey) return;
    store.reset(sessionKey);
    notify();
  }, [notify, sessionKey, store]);

  return useMemo(() => ({
    messages: sessionKey && version !== '' ? store.messages(sessionKey) : [],
    ingestGatewayEvent,
    hydrateHistory,
    reset,
  }), [
    sessionKey,
    version,
    store,
    ingestGatewayEvent,
    hydrateHistory,
    reset,
  ]);
}
