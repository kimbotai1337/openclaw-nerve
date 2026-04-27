import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const buildRealtimeSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/rate-limit.js', () => ({
  rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../lib/realtime-snapshot.js', () => ({
  buildRealtimeSnapshot: buildRealtimeSnapshotMock,
}));

async function buildApp() {
  const mod = await import('./realtime.js');
  const app = new Hono();
  app.route('/', mod.default);
  return app;
}

describe('GET /api/realtime/snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when sessionKey is missing', async () => {
    const app = await buildApp();

    const response = await app.request('/api/realtime/snapshot');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Too small: expected string to have >=1 characters',
    });
  });

  it('returns the snapshot payload for a valid request', async () => {
    buildRealtimeSnapshotMock.mockResolvedValue({
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 12,
        sourceVersion: '12|idle||||0|0|0',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 20,
      source: 'server-reconcile',
    });

    const app = await buildApp();
    const response = await app.request('/api/realtime/snapshot?sessionKey=agent%3Amain%3Amain&limit=75');

    expect(response.status).toBe(200);
    expect(buildRealtimeSnapshotMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      limit: 75,
    });
    expect(await response.json()).toEqual({
      ok: true,
      snapshot: {
        session: {
          sessionId: 'agent:main:main',
          status: 'idle',
          agentId: 'main',
          updatedAt: 12,
          sourceVersion: '12|idle||||0|0|0',
        },
        runs: [],
        messages: [],
        agentPresence: null,
        recoveredAt: 20,
        source: 'server-reconcile',
      },
    });
  });
});
