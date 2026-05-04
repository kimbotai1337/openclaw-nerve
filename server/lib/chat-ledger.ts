import { EventEmitter } from 'node:events';

export interface ChatLedgerRecord {
  cursor: number;
  sessionKey: string;
  type: string;
  payload: unknown;
  ts: number;
}

export interface ChatLedgerReplay {
  cursor: number;
  events: ChatLedgerRecord[];
}

export interface ChatLedgerOptions {
  maxEventsPerSession?: number;
}

export class ChatLedger extends EventEmitter {
  private readonly maxEventsPerSession: number;
  private cursor = 0;
  private bySession = new Map<string, ChatLedgerRecord[]>();

  constructor(options: ChatLedgerOptions = {}) {
    super();
    this.maxEventsPerSession = Math.max(1, options.maxEventsPerSession ?? 500);
    this.setMaxListeners(200);
  }

  append(sessionKey: string, type: string, payload: unknown, ts = Date.now()): ChatLedgerRecord {
    const record: ChatLedgerRecord = {
      cursor: ++this.cursor,
      sessionKey,
      type,
      payload,
      ts,
    };
    const events = [...(this.bySession.get(sessionKey) || []), record].slice(-this.maxEventsPerSession);
    this.bySession.set(sessionKey, events);
    this.emit('event', record);
    return record;
  }

  replay(sessionKey: string, afterCursor = 0): ChatLedgerReplay {
    const events = (this.bySession.get(sessionKey) || [])
      .filter((record) => record.cursor > afterCursor);
    return {
      cursor: this.cursor,
      events,
    };
  }

  clear(): void {
    this.cursor = 0;
    this.bySession.clear();
    this.removeAllListeners();
  }
}

export const chatLedger = new ChatLedger();
