import type { ChatMsg } from '@/features/chat/types';
import type { ChatMessage, GatewayEvent } from '@/types';
import {
  createChatTimelineState,
  reduceTimelineEvent,
  selectTimelineMessages,
} from '@/features/chat/timeline/reducer';
import { normalizeGatewayEvent } from '@/features/chat/timeline/normalizeGatewayEvent';
import type { ChatTimelineEvent, ChatTimelineState } from '@/features/chat/timeline/types';
import {
  persistSelectedSession as persistSelectedSessionValue,
  restoreSelectedSession as restoreSelectedSessionValue,
  type SelectedSessionStorage,
} from './selectedSessionStorage';

export class ChatTimelineStore {
  private sessions = new Map<string, ChatTimelineState>();

  static persistSelectedSession(sessionKey: string, storage?: SelectedSessionStorage): void {
    persistSelectedSessionValue(sessionKey, storage);
  }

  static restoreSelectedSession(storage?: SelectedSessionStorage): string | null {
    return restoreSelectedSessionValue(storage);
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
