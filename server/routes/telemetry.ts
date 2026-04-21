import { Hono } from 'hono';
import { z } from 'zod';
import { getTelemetryRuntime } from '../lib/telemetry/runtime.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const app = new Hono();

const sessionOpenedEventSchema = z.object({
  event: z.literal('session_opened'),
}).strict();

const branchCreatedEventSchema = z.object({
  event: z.literal('branch_created'),
}).strict();

const branchSwitchedEventSchema = z.object({
  event: z.literal('branch_switched'),
  properties: z.object({
    success: z.boolean(),
  }).strict(),
}).strict();

const uiTelemetryEventSchema = z.union([
  sessionOpenedEventSchema,
  branchCreatedEventSchema,
  branchSwitchedEventSchema,
]);

async function recordUiTelemetryEvent(payload: z.infer<typeof uiTelemetryEventSchema>): Promise<void> {
  const telemetry = getTelemetryRuntime();
  if (!telemetry) return;

  try {
    if (payload.event === 'session_opened') {
      await telemetry.markFeatureUsed('sessions');
      return;
    }

    if (payload.event === 'branch_created') {
      await telemetry.markFeatureUsed('branches');
      return;
    }

    if (payload.event === 'branch_switched') {
      await Promise.allSettled([
        telemetry.markFeatureUsed('branches'),
        telemetry.recordClientDetailedEvent(payload),
      ]);
      return;
    }

    await telemetry.recordClientDetailedEvent(payload);
  } catch {
    return;
  }
}

app.post('/api/telemetry/events', rateLimitGeneral, async (c) => {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return c.text('Invalid JSON body', 400);
  }

  const parsed = uiTelemetryEventSchema.safeParse(body);
  if (!parsed.success) {
    return c.text('Invalid telemetry payload', 400);
  }

  await recordUiTelemetryEvent(parsed.data);
  return c.json({ ok: true });
});

export default app;
