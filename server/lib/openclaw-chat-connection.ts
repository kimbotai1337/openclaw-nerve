import { chatLedger } from './chat-ledger.js';

const CHAT_LEDGER_EVENTS = new Set(['chat', 'agent', 'session.tool']);
const RECENT_FRAME_TTL_MS = 2 * 60 * 1000;
const MAX_RECENT_FRAMES = 2_000;
const recentGatewayFrames = new Map<string, number>();

function frameKey(event: string, sessionKey: string, payload: unknown): string {
  return `${event}\0${sessionKey}\0${JSON.stringify(payload)}`;
}

function shouldRecordFrame(key: string, now: number): boolean {
  const previous = recentGatewayFrames.get(key);
  if (previous !== undefined && now - previous <= RECENT_FRAME_TTL_MS) {
    return false;
  }

  recentGatewayFrames.set(key, now);
  if (recentGatewayFrames.size > MAX_RECENT_FRAMES) {
    for (const [candidate, seenAt] of recentGatewayFrames) {
      if (now - seenAt > RECENT_FRAME_TTL_MS || recentGatewayFrames.size > MAX_RECENT_FRAMES) {
        recentGatewayFrames.delete(candidate);
      }
      if (recentGatewayFrames.size <= MAX_RECENT_FRAMES) break;
    }
  }
  return true;
}

export function clearOpenClawGatewayFrameDedupeForTests(): void {
  recentGatewayFrames.clear();
}

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
    const now = Date.now();
    if (!shouldRecordFrame(frameKey(msg.event, sessionKey, msg.payload), now)) return;
    chatLedger.append(sessionKey, msg.event, msg.payload, now);
  } catch {
    // Recording is best-effort; proxy relay correctness must not depend on it.
  }
}
