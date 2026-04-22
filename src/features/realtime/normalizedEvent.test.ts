import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@/types';
import {
  normalizeGatewayEvent,
  normalizeLocalRunCreated,
  normalizeSnapshotLoaded,
} from './normalizedEvent';

describe('normalized realtime events', () => {
  it('maps a chat delta into run + message events', () => {
    const event: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 4,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        seq: 11,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    };

    const normalized = normalizeGatewayEvent(event);
    expect(normalized.map((entry) => entry.type)).toEqual([
      'run.status_changed',
      'message.delta_applied',
    ]);
  });

  it('maps an agent lifecycle event into presence update', () => {
    const event: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 3,
      payload: {
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    };

    const normalized = normalizeGatewayEvent(event);
    expect(normalized.some((entry) => entry.type === 'agent.presence_updated')).toBe(true);
  });

  it('creates a local run-created event from send acknowledgement', () => {
    const normalized = normalizeLocalRunCreated('agent:main:main', 'run-9', 100);
    expect(normalized.type).toBe('run.created');
    expect(normalized.runId).toBe('run-9');
  });

  it('wraps snapshot payloads in a reducer event', () => {
    const normalized = normalizeSnapshotLoaded({
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 200,
        sourceVersion: 'snapshot-9',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 200,
      source: 'server-reconcile',
    });

    expect(normalized.type).toBe('snapshot.loaded');
  });
});
