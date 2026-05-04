import type { ChatMessage, GatewayEvent } from '@/types';

export interface ChatLedgerRecord {
  cursor: number;
  sessionKey: string;
  type: string;
  payload: unknown;
  ts: number;
}

export interface ChatSnapshot {
  sessionKey: string;
  history: {
    messages?: ChatMessage[];
  };
  events: ChatLedgerRecord[];
  cursor: number;
  fromCursor?: number;
  hasGap?: boolean;
}

export interface FetchChatSnapshotOptions {
  cursor?: number;
  limit?: number;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `${url} failed with HTTP ${res.status}`);
  }
  return await res.json() as T;
}

export async function fetchChatSnapshot(
  sessionKey: string,
  options: FetchChatSnapshotOptions = {},
): Promise<ChatSnapshot> {
  const params = new URLSearchParams();
  if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor));
  if (typeof options.limit === 'number') params.set('limit', String(options.limit));
  const query = params.toString();
  const res = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionKey)}/snapshot${query ? `?${query}` : ''}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Chat snapshot failed with HTTP ${res.status}`);
  }
  return await res.json() as ChatSnapshot;
}

export interface SendChatParams {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
  attachments?: unknown[];
  images?: unknown[];
}

export async function sendChat(params: SendChatParams): Promise<unknown> {
  return postJson('/api/chat/send', {
    sessionKey: params.sessionKey,
    message: params.message,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.attachments ? { attachments: params.attachments } : {}),
    ...(params.images ? { images: params.images } : {}),
  });
}

export async function abortChat(sessionKey: string): Promise<unknown> {
  return postJson('/api/chat/abort', { sessionKey });
}

export async function refreshChatSnapshot(
  sessionKey: string,
  options: FetchChatSnapshotOptions = {},
): Promise<ChatSnapshot> {
  return postJson('/api/chat/refresh', {
    sessionKey,
    ...(typeof options.cursor === 'number' ? { cursor: options.cursor } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
  });
}

export function subscribeChatEvents(
  sessionKey: string,
  cursor: number,
  onRecord: (record: ChatLedgerRecord) => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};

  const params = new URLSearchParams({ sessionKey });
  if (cursor > 0) params.set('cursor', String(cursor));

  const source = new EventSource(`/api/chat/events?${params.toString()}`);
  const handleTimelineEvent = (event: MessageEvent<string>) => {
    try {
      onRecord(JSON.parse(event.data) as ChatLedgerRecord);
    } catch {
      // Ignore malformed server-sent events; the connection will keep streaming.
    }
  };

  source.addEventListener('chat.timeline', handleTimelineEvent);

  return () => {
    source.removeEventListener('chat.timeline', handleTimelineEvent);
    source.close();
  };
}

export function ledgerRecordToGatewayEvent(record: ChatLedgerRecord): GatewayEvent | null {
  if (record.type !== 'chat' && record.type !== 'agent' && record.type !== 'session.tool') {
    return null;
  }
  return {
    type: 'event',
    event: record.type,
    seq: record.cursor,
    ts: record.ts,
    payload: record.payload,
  };
}
