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
  fromCursor?: number;
  hasGap: boolean;
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
    const stored = this.bySession.get(sessionKey) || [];
    const events = stored.filter((record) => record.cursor > afterCursor);
    const fromCursor = stored[0]?.cursor;
    return {
      cursor: this.cursor,
      events,
      fromCursor,
      hasGap: fromCursor !== undefined && afterCursor > 0 && afterCursor < fromCursor,
    };
  }

  /** Reset stored events while preserving live SSE listeners unless explicitly requested. */
  clear(options: { removeListeners?: boolean } = {}): void {
    this.cursor = 0;
    this.bySession.clear();
    if (options.removeListeners) this.removeAllListeners();
  }

  /** Test-only reset that also removes listener state between specs. */
  clearForTests(): void {
    this.clear({ removeListeners: true });
  }
}

export const chatLedger = new ChatLedger();
