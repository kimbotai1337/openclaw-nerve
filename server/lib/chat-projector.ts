import { gatewayRpcCall } from './gateway-rpc.js';
import { chatLedger } from './chat-ledger.js';

export interface ChatSnapshotOptions {
  sessionKey: string;
  cursor?: number;
  limit?: number;
}

export async function buildChatSnapshot(options: ChatSnapshotOptions) {
  const limit = options.limit ?? 500;
  const cursor = options.cursor ?? 0;
  const history = await gatewayRpcCall('chat.history', {
    sessionKey: options.sessionKey,
    limit,
  });
  const replay = chatLedger.replay(options.sessionKey, cursor);
  return {
    sessionKey: options.sessionKey,
    history,
    events: replay.events,
    cursor: replay.cursor,
    fromCursor: replay.fromCursor,
    hasGap: replay.hasGap,
  };
}
