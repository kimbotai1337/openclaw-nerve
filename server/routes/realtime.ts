import { Hono } from 'hono';
import { z } from 'zod';
import { buildRealtimeSnapshot } from '../lib/realtime-snapshot.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const DEFAULT_LIMIT = 100;

const snapshotQuerySchema = z.object({
  sessionKey: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMIT),
});

const app = new Hono();

app.get('/api/realtime/snapshot', rateLimitGeneral, async (c) => {
  const parsed = snapshotQuerySchema.safeParse({
    sessionKey: c.req.query('sessionKey')?.trim() ?? '',
    limit: c.req.query('limit') ?? DEFAULT_LIMIT,
  });

  if (!parsed.success) {
    return c.json({
      ok: false,
      error: parsed.error.issues[0]?.message || 'Invalid query',
    }, 400);
  }

  const snapshot = await buildRealtimeSnapshot(parsed.data);
  return c.json({ ok: true, snapshot });
});

export default app;
