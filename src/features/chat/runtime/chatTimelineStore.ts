import type { ChatMsg } from '@/features/chat/types';
import type { ChatMessage, GatewayEvent } from '@/types';
import {
  createChatTimelineState,
  reduceTimelineEvent,
  selectTimelineMessages,
} from '@/features/chat/timeline/reducer';
import { normalizeGatewayEvent } from '@/features/chat/timeline/normalizeGatewayEvent';
import type { ChatTimelineEvent, ChatTimelineState } from '@/features/chat/timeline/types';

const SELECTED_SESSION_STORAGE_KEY = 'nerve:chat:selected-session';

export interface SelectedSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

export class ChatTimelineStore {
  private sessions = new Map<string, ChatTimelineState>();

  static persistSelectedSession(sessionKey: string, storage: SelectedSessionStorage = window.localStorage): void {
    if (sessionKey.trim()) {
      storage.setItem(SELECTED_SESSION_STORAGE_KEY, sessionKey);
    } else {
      storage.removeItem(SELECTED_SESSION_STORAGE_KEY);
    }
  }

  static restoreSelectedSession(storage: SelectedSessionStorage = window.localStorage): string | null {
    const value = storage.getItem(SELECTED_SESSION_STORAGE_KEY);
    return value?.trim() || null;
  }

  getState(sessionKey: string): ChatTimelineState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = createChatTimelineState(sessionKey);
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  dispatch(event: ChatTimelineEvent): ChatTimelineState {
    const current = this.getState(event.sessionKey);
    const next = reduceTimelineEvent(current, event);
    this.sessions.set(event.sessionKey, next);
    return next;
  }

  ingestGatewayEvent(event: GatewayEvent): ChatTimelineEvent[] {
    const events = normalizeGatewayEvent(event);
    for (const normalized of events) {
      this.dispatch(normalized);
    }
    return events;
  }

  hydrateHistory(sessionKey: string, messages: ChatMessage[]): ChatTimelineState {
    return this.dispatch({
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages,
    });
  }

  messages(sessionKey: string): ChatMsg[] {
    return selectTimelineMessages(this.getState(sessionKey));
  }

  reset(sessionKey: string): void {
    this.sessions.set(sessionKey, createChatTimelineState(sessionKey));
  }

  clear(): void {
    this.sessions.clear();
  }
}
