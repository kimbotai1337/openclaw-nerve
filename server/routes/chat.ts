import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { gatewayRpcCall } from '../lib/gateway-rpc.js';
import { chatLedger, type ChatLedgerRecord } from '../lib/chat-ledger.js';

const app = new Hono();

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseCursor(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

async function buildSnapshot(sessionKey: string, cursor: number, limit: number) {
  const history = await gatewayRpcCall('chat.history', { sessionKey, limit });
  const replay = chatLedger.replay(sessionKey, cursor);
  return {
    sessionKey,
    history,
    events: replay.events,
    cursor: replay.cursor,
  };
}

app.get('/api/chat/sessions/:sessionKey/snapshot', async (c) => {
  const sessionKey = decodeURIComponent(c.req.param('sessionKey'));
  const limit = parsePositiveInt(c.req.query('limit'), 500, 1000);
  const cursor = parseCursor(c.req.query('cursor'));

  try {
    return c.json(await buildSnapshot(sessionKey, cursor, limit));
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) }, 502);
  }
});

app.post('/api/chat/send', async (c) => {
  const body = await readJsonObject(c);
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
  const message = typeof body.message === 'string' ? body.message : '';
  if (!sessionKey || !message.trim()) {
    return c.json({ ok: false, error: 'sessionKey and message are required' }, 400);
  }

  const params: Record<string, unknown> = {
    sessionKey,
    message,
    deliver: false,
  };
  if (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) {
    params.idempotencyKey = body.idempotencyKey;
  }
  if (Array.isArray(body.attachments)) {
    params.attachments = body.attachments;
  }
  if (Array.isArray(body.images)) {
    params.images = body.images;
  }

  try {
    return c.json(await gatewayRpcCall('chat.send', params));
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) }, 502);
  }
});

app.post('/api/chat/abort', async (c) => {
  const body = await readJsonObject(c);
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
  if (!sessionKey) {
    return c.json({ ok: false, error: 'sessionKey is required' }, 400);
  }

  try {
    return c.json(await gatewayRpcCall('chat.abort', { sessionKey }));
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) }, 502);
  }
});

app.post('/api/chat/refresh', async (c) => {
  const body = await readJsonObject(c);
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
  if (!sessionKey) {
    return c.json({ ok: false, error: 'sessionKey is required' }, 400);
  }
  const cursor = typeof body.cursor === 'number' ? parseCursor(String(body.cursor)) : 0;
  const limit = typeof body.limit === 'number' ? Math.min(Math.max(Math.floor(body.limit), 1), 1000) : 500;

  try {
    return c.json(await buildSnapshot(sessionKey, cursor, limit));
  } catch (error) {
    return c.json({ ok: false, error: errorMessage(error) }, 502);
  }
});

app.get('/api/chat/events', async (c) => {
  const sessionKey = c.req.query('sessionKey');
  if (!sessionKey) return c.json({ ok: false, error: 'sessionKey is required' }, 400);
  const cursor = parseCursor(c.req.query('cursor'));

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    let connected = true;
    let resolveDisconnect: (() => void) | undefined;

    const writeRecord = async (record: ChatLedgerRecord) => {
      if (!connected || record.sessionKey !== sessionKey) return;
      try {
        await stream.writeSSE({
          event: 'chat.timeline',
          data: JSON.stringify(record),
          id: String(record.cursor),
        });
      } catch {
        disconnect();
      }
    };

    function disconnect() {
      if (!connected) return;
      connected = false;
      chatLedger.off('event', writeRecord);
      resolveDisconnect?.();
    }

    for (const record of chatLedger.replay(sessionKey, cursor).events) {
      await writeRecord(record);
    }

    chatLedger.on('event', writeRecord);
    stream.onAbort(() => disconnect());

    await new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
      if (!connected) resolve();
    });
  });
});

export default app;
