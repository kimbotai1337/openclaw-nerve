import { chatLedger } from './chat-ledger.js';

const CHAT_LEDGER_EVENTS = new Set(['chat', 'agent', 'session.tool']);

export function recordOpenClawGatewayFrame(raw: string): void {
  try {
    const msg = JSON.parse(raw) as {
      type?: string;
      event?: string;
      payload?: { sessionKey?: string };
    };
    if (msg.type !== 'event' || !msg.event || !CHAT_LEDGER_EVENTS.has(msg.event)) return;
    const sessionKey = msg.payload?.sessionKey;
    if (!sessionKey) return;
    chatLedger.append(sessionKey, msg.event, msg.payload);
  } catch {
    // Recording is best-effort; proxy relay correctness must not depend on it.
  }
}
