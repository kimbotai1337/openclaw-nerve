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
}

export interface FetchChatSnapshotOptions {
  cursor?: number;
  limit?: number;
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

export function ledgerRecordToGatewayEvent(record: ChatLedgerRecord): GatewayEvent | null {
  if (record.type !== 'chat' && record.type !== 'agent' && record.type !== 'session.tool') {
    return null;
  }
  return {
    type: 'event',
    event: record.type,
    seq: record.cursor,
    payload: record.payload,
  };
}
