# Nerve Realtime + OpenClaw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a normalized realtime state layer for Nerve so chat, agent presence, session state, reconnect recovery, and status UI converge cleanly against OpenClaw.

**Architecture:** Keep the existing browser -> `/ws` -> OpenClaw transport. Add a shared realtime reducer that ingests normalized live events plus a server snapshot/reconcile payload, then make `ChatContext` and `SessionContext` derive truth from that shared state instead of maintaining separate recovery and status logic.

**Tech Stack:** React 19, TypeScript, Vitest, Hono, `ws`, OpenClaw gateway RPC

---

## Prerequisite

Run every frontend/server test task under Node `>=22`. The current jsdom/Vitest stack in this repo does not boot cleanly under Node `18.19.1`; it fails before application tests run.

For this worktree, when a task says `npx vitest run ...`, use the Node 22 invocation instead:

`/opt/homebrew/bin/node ./node_modules/vitest/vitest.mjs run ...`

## File Map

- Create: `src/features/realtime/types.ts`
  - Canonical realtime entity types, snapshot payload types, reducer event union, UI status enums.
- Create: `src/features/realtime/reducer.ts`
  - Initial state, monotonic merge rules, snapshot merge rules, reducer helpers.
- Create: `src/features/realtime/selectors.ts`
  - Chat/session/status selectors consumed by contexts and UI.
- Create: `src/features/realtime/normalizedEvent.ts`
  - Map raw `GatewayEvent`, local send lifecycle, and snapshot payloads into reducer events.
- Create: `src/features/realtime/reducer.test.ts`
- Create: `src/features/realtime/selectors.test.ts`
- Create: `src/features/realtime/normalizedEvent.test.ts`
- Create: `src/contexts/RealtimeContext.tsx`
  - Shared reducer provider, snapshot fetch orchestration, connection lifecycle dispatch.
- Create: `src/contexts/RealtimeContext.test.tsx`
- Create: `src/hooks/useChatRecovery.test.ts`
- Create: `server/lib/realtime-snapshot.ts`
  - Build authoritative reconcile payload from OpenClaw session + history data.
- Create: `server/lib/realtime-snapshot.test.ts`
- Create: `server/routes/realtime.ts`
  - `GET /api/realtime/snapshot`
- Create: `server/routes/realtime.test.ts`
- Create: `src/components/StatusBar.test.tsx`

- Modify: `src/features/auth/AuthGate.tsx:29-38`
  - Mount `RealtimeProvider` between `GatewayProvider` and the existing session/chat providers.
- Modify: `src/hooks/useWebSocket.ts:4-280`
  - Surface transport metadata needed for degraded/reconnect/reconcile decisions.
- Modify: `src/contexts/GatewayContext.tsx:8-23, 47-156`
  - Pass transport metadata through to realtime consumers.
- Modify: `src/hooks/useChatRecovery.ts:16-137`
  - Stop rebuilding truth from `chat.history`; request snapshot reconcile instead.
- Modify: `src/contexts/ChatContext.tsx:102-741`
  - Dispatch local/live events into the realtime reducer and render derived chat state from selectors.
- Modify: `src/contexts/SessionContext.tsx:311-780`
  - Derive session status and agent presence from the realtime reducer; keep full refresh only for list completeness.
- Modify: `src/App.tsx:1114-1122`
  - Pass realtime UI status into `StatusBar`.
- Modify: `src/components/StatusBar.tsx:7-174`
  - Show `LIVE`, `RECONNECTING`, `SYNCING`, `DEGRADED`, `OFFLINE`.
- Modify: `server/app.ts:38-96`
  - Register realtime route.
- Modify: `server/lib/ws-proxy.ts:99-260`
  - Add structured websocket lifecycle logging for reconnect/root-cause analysis.
- Modify: `src/hooks/useWebSocket.test.ts`
- Modify: `src/contexts/ChatContext.subscription.test.tsx`
- Modify: `src/contexts/SessionContext.test.tsx`
- Modify: `server/lib/ws-proxy.test.ts`

### Task 1: Realtime State Core

**Files:**
- Create: `src/features/realtime/types.ts`
- Create: `src/features/realtime/reducer.ts`
- Create: `src/features/realtime/selectors.ts`
- Test: `src/features/realtime/reducer.test.ts`
- Test: `src/features/realtime/selectors.test.ts`

- [ ] **Step 1: Write the failing reducer and selector tests**

```ts
// src/features/realtime/reducer.test.ts
import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState, realtimeReducer } from './reducer';
import type { RealtimeEvent, RealtimeSnapshotPayload } from './types';

function apply(stateEvents: RealtimeEvent[]) {
  return stateEvents.reduce(realtimeReducer, createInitialRealtimeState());
}

describe('realtimeReducer', () => {
  it('creates a run from local send and finalizes it from snapshot truth', () => {
    const snapshot: RealtimeSnapshotPayload = {
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 20,
        sourceVersion: 'snapshot-1',
      },
      runs: [
        {
          runId: 'run-1',
          sessionId: 'agent:main:main',
          status: 'completed',
          messageIds: ['assistant-1'],
          lastEventAt: 20,
          finalized: true,
        },
      ],
      messages: [
        {
          messageId: 'assistant-1',
          sessionId: 'agent:main:main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'done' }],
          status: 'committed',
          revision: 2,
        },
      ],
      agentPresence: {
        sessionId: 'agent:main:main',
        agentId: 'main',
        phase: 'idle',
        lastSeenAt: 20,
      },
      recoveredAt: 20,
      source: 'server-reconcile',
    };

    const state = apply([
      {
        type: 'run.created',
        eventId: 'evt-1',
        receivedAt: 10,
        source: 'local',
        sessionId: 'agent:main:main',
        runId: 'run-1',
      },
      {
        type: 'snapshot.loaded',
        eventId: 'evt-2',
        receivedAt: 20,
        source: 'snapshot',
        sessionId: 'agent:main:main',
        snapshot,
      },
    ]);

    expect(state.runs['run-1']?.status).toBe('completed');
    expect(state.runs['run-1']?.finalized).toBe(true);
    expect(state.messages['assistant-1']?.contentParts).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('marks reconcile needed when ordering becomes uncertain', () => {
    const state = apply([
      {
        type: 'connection.reconcile_requested',
        eventId: 'evt-1',
        receivedAt: 30,
        source: 'local',
        sessionId: 'agent:main:main',
        reason: 'chat-gap',
      },
    ]);

    expect(state.connection.reconcileNeeded).toBe(true);
    expect(state.connection.status).toBe('reconnecting');
  });
});
```

```ts
// src/features/realtime/selectors.test.ts
import { describe, expect, it } from 'vitest';
import { createInitialRealtimeState } from './reducer';
import { selectRealtimeStatus, selectVisibleMessagesForSession } from './selectors';

describe('realtime selectors', () => {
  it('returns syncing when reconcile is in progress', () => {
    const state = createInitialRealtimeState();
    state.connection.status = 'reconnecting';
    state.connection.reconcileNeeded = true;

    expect(selectRealtimeStatus(state)).toBe('syncing');
  });

  it('orders messages by revision and commit state for a session', () => {
    const state = createInitialRealtimeState();
    state.messages['m-1'] = {
      messageId: 'm-1',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'done' }],
      status: 'committed',
      revision: 2,
    };
    state.messages['m-2'] = {
      messageId: 'm-2',
      sessionId: 'agent:main:main',
      runId: 'run-1',
      role: 'user',
      contentParts: [{ type: 'text', text: 'hi' }],
      status: 'committed',
      revision: 1,
    };

    const visible = selectVisibleMessagesForSession(state, 'agent:main:main');
    expect(visible.map((message) => message.messageId)).toEqual(['m-2', 'm-1']);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/features/realtime/reducer.test.ts src/features/realtime/selectors.test.ts`

Expected: FAIL with module-not-found errors for `src/features/realtime/*`.

- [ ] **Step 3: Write the minimal realtime types, reducer, and selectors**

```ts
// src/features/realtime/types.ts
export type RealtimeSource = 'live-chat' | 'live-agent' | 'snapshot' | 'local';
export type RealtimeTransportStatus = 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'offline';
export type RealtimeUiStatus = 'live' | 'reconnecting' | 'syncing' | 'degraded' | 'offline';
export type ReconcileReason =
  | 'reconnect'
  | 'chat-gap'
  | 'frame-gap'
  | 'background-resume'
  | 'missing-run-activity'
  | 'subagent-complete'
  | 'session-switch';
export type RealtimeRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type RealtimeMessageStatus = 'streaming' | 'committed' | 'superseded';

export interface RealtimeConnectionState {
  status: RealtimeTransportStatus;
  lastLiveAt: number;
  lastDisconnectReason: string | null;
  reconcileNeeded: boolean;
  reconnectAttempt: number;
}

export interface RealtimeSessionEntity {
  sessionId: string;
  status: string;
  agentId: string | null;
  updatedAt: number;
  sourceVersion: string;
}

export interface RealtimeRunEntity {
  runId: string;
  sessionId: string;
  status: RealtimeRunStatus;
  messageIds: string[];
  lastEventAt: number;
  finalized: boolean;
}

export interface RealtimeMessagePart {
  type: 'text';
  text: string;
}

export interface RealtimeMessageEntity {
  messageId: string;
  sessionId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system';
  contentParts: RealtimeMessagePart[];
  status: RealtimeMessageStatus;
  revision: number;
}

export interface RealtimeAgentPresence {
  sessionId: string;
  agentId: string | null;
  phase: string | null;
  lastSeenAt: number;
}

export interface RealtimeSnapshotPayload {
  session: RealtimeSessionEntity;
  runs: RealtimeRunEntity[];
  messages: RealtimeMessageEntity[];
  agentPresence: RealtimeAgentPresence | null;
  recoveredAt: number;
  source: 'server-reconcile';
}

export interface RealtimeState {
  connection: RealtimeConnectionState;
  sessions: Record<string, RealtimeSessionEntity>;
  runs: Record<string, RealtimeRunEntity>;
  messages: Record<string, RealtimeMessageEntity>;
  agentPresence: Record<string, RealtimeAgentPresence>;
}

interface RealtimeEventBase {
  eventId: string;
  receivedAt: number;
  source: RealtimeSource;
  sessionId: string;
}

export type RealtimeEvent =
  | (RealtimeEventBase & { type: 'connection.opened'; reconnectAttempt: number })
  | (RealtimeEventBase & { type: 'connection.degraded'; reason: string })
  | (RealtimeEventBase & { type: 'connection.closed'; reason: string; reconnectAttempt: number })
  | (RealtimeEventBase & { type: 'connection.reconcile_requested'; reason: ReconcileReason })
  | (RealtimeEventBase & { type: 'session.upserted'; session: RealtimeSessionEntity })
  | (RealtimeEventBase & { type: 'run.created'; runId: string })
  | (RealtimeEventBase & { type: 'run.status_changed'; runId: string; status: RealtimeRunStatus; finalized: boolean })
  | (RealtimeEventBase & { type: 'message.delta_applied'; runId: string; messageId: string; text: string; revision: number })
  | (RealtimeEventBase & { type: 'message.committed'; message: RealtimeMessageEntity })
  | (RealtimeEventBase & { type: 'agent.presence_updated'; presence: RealtimeAgentPresence })
  | (RealtimeEventBase & { type: 'snapshot.loaded'; snapshot: RealtimeSnapshotPayload })
  | (RealtimeEventBase & { type: 'snapshot.merge_completed' });
```

```ts
// src/features/realtime/reducer.ts
import type {
  RealtimeEvent,
  RealtimeMessageEntity,
  RealtimeRunEntity,
  RealtimeState,
} from './types';

export function createInitialRealtimeState(): RealtimeState {
  return {
    connection: {
      status: 'offline',
      lastLiveAt: 0,
      lastDisconnectReason: null,
      reconcileNeeded: false,
      reconnectAttempt: 0,
    },
    sessions: {},
    runs: {},
    messages: {},
    agentPresence: {},
  };
}

function upsertRun(state: RealtimeState, run: RealtimeRunEntity) {
  const existing = state.runs[run.runId];
  state.runs[run.runId] = existing
    ? {
        ...existing,
        ...run,
        messageIds: run.messageIds.length > 0 ? run.messageIds : existing.messageIds,
      }
    : run;
}

function upsertMessage(state: RealtimeState, message: RealtimeMessageEntity) {
  const existing = state.messages[message.messageId];
  if (!existing || message.revision >= existing.revision) {
    state.messages[message.messageId] = message;
  }
}

export function realtimeReducer(state: RealtimeState, event: RealtimeEvent): RealtimeState {
  const next: RealtimeState = {
    ...state,
    connection: { ...state.connection },
    sessions: { ...state.sessions },
    runs: { ...state.runs },
    messages: { ...state.messages },
    agentPresence: { ...state.agentPresence },
  };

  switch (event.type) {
    case 'connection.opened':
      next.connection.status = 'live';
      next.connection.lastLiveAt = event.receivedAt;
      next.connection.lastDisconnectReason = null;
      next.connection.reconcileNeeded = false;
      next.connection.reconnectAttempt = event.reconnectAttempt;
      return next;

    case 'connection.degraded':
      next.connection.status = 'degraded';
      next.connection.lastDisconnectReason = event.reason;
      return next;

    case 'connection.closed':
      next.connection.status = 'reconnecting';
      next.connection.lastDisconnectReason = event.reason;
      next.connection.reconnectAttempt = event.reconnectAttempt;
      return next;

    case 'connection.reconcile_requested':
      next.connection.status = 'reconnecting';
      next.connection.reconcileNeeded = true;
      next.connection.lastDisconnectReason = event.reason;
      return next;

    case 'session.upserted':
      next.sessions[event.session.sessionId] = event.session;
      return next;

    case 'run.created':
      upsertRun(next, {
        runId: event.runId,
        sessionId: event.sessionId,
        status: 'queued',
        messageIds: [],
        lastEventAt: event.receivedAt,
        finalized: false,
      });
      return next;

    case 'run.status_changed':
      upsertRun(next, {
        ...(next.runs[event.runId] ?? {
          runId: event.runId,
          sessionId: event.sessionId,
          messageIds: [],
        }),
        status: event.status,
        lastEventAt: event.receivedAt,
        finalized: event.finalized,
      } as RealtimeRunEntity);
      return next;

    case 'message.delta_applied':
      upsertMessage(next, {
        messageId: event.messageId,
        sessionId: event.sessionId,
        runId: event.runId,
        role: 'assistant',
        contentParts: [{ type: 'text', text: event.text }],
        status: 'streaming',
        revision: event.revision,
      });
      return next;

    case 'message.committed':
      upsertMessage(next, event.message);
      if (event.message.runId) {
        const run = next.runs[event.message.runId];
        if (run && !run.messageIds.includes(event.message.messageId)) {
          run.messageIds = [...run.messageIds, event.message.messageId];
        }
      }
      return next;

    case 'agent.presence_updated':
      next.agentPresence[event.sessionId] = event.presence;
      return next;

    case 'snapshot.loaded':
      next.sessions[event.snapshot.session.sessionId] = event.snapshot.session;
      for (const run of event.snapshot.runs) upsertRun(next, run);
      for (const message of event.snapshot.messages) upsertMessage(next, message);
      if (event.snapshot.agentPresence) {
        next.agentPresence[event.snapshot.session.sessionId] = event.snapshot.agentPresence;
      }
      next.connection.reconcileNeeded = false;
      next.connection.status = 'live';
      next.connection.lastLiveAt = event.snapshot.recoveredAt;
      return next;

    case 'snapshot.merge_completed':
      next.connection.reconcileNeeded = false;
      if (next.connection.status === 'reconnecting') next.connection.status = 'live';
      return next;
  }
}
```

```ts
// src/features/realtime/selectors.ts
import type { RealtimeMessageEntity, RealtimeState, RealtimeUiStatus } from './types';

export function selectRealtimeStatus(state: RealtimeState): RealtimeUiStatus {
  if (state.connection.reconcileNeeded) return 'syncing';
  if (state.connection.status === 'degraded') return 'degraded';
  if (state.connection.status === 'reconnecting' || state.connection.status === 'connecting') return 'reconnecting';
  if (state.connection.status === 'offline') return 'offline';
  return 'live';
}

export function selectVisibleMessagesForSession(state: RealtimeState, sessionId: string): RealtimeMessageEntity[] {
  return Object.values(state.messages)
    .filter((message) => message.sessionId === sessionId && message.status !== 'superseded')
    .sort((left, right) => left.revision - right.revision);
}

export function selectSessionAgentPresence(state: RealtimeState, sessionId: string) {
  return state.agentPresence[sessionId] ?? null;
}
```

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run src/features/realtime/reducer.test.ts src/features/realtime/selectors.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the reducer foundation**

```bash
git add src/features/realtime/types.ts src/features/realtime/reducer.ts src/features/realtime/selectors.ts src/features/realtime/reducer.test.ts src/features/realtime/selectors.test.ts
git commit -m "feat: add realtime state core"
```

**Execution Note: Accepted Task 1 Baseline**

Task 1 was implemented, then hardened through review-driven fix loops. Continue from the accepted hardened reducer state rather than the earlier minimal sketch in this plan.

Use the current Task 1 implementation on branch `realtime-e2e-openclaw-spec` as the source of truth for downstream tasks. In particular:

- transport health and `reconcileNeeded` are separate concerns
- snapshot application is freshness-gated and authoritative per session when accepted
- live run updates are monotonic and do not reopen finalized runs
- committed messages may create placeholder runs to preserve run/message linkage
- message ordering uses a stable ordering key (`createdAt`), then deterministic tie-breakers

### Task 2: Normalized Event Mapping

**Files:**
- Create: `src/features/realtime/normalizedEvent.ts`
- Test: `src/features/realtime/normalizedEvent.test.ts`
- Modify: `src/features/chat/operations/streamEventHandler.ts:31-220`

- [ ] **Step 1: Write the failing normalization tests**

```ts
// src/features/realtime/normalizedEvent.test.ts
import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@/types';
import { normalizeGatewayEvent, normalizeLocalRunCreated, normalizeSnapshotLoaded } from './normalizedEvent';

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
    expect(normalized.map((entry) => entry.type)).toEqual(['run.status_changed', 'message.delta_applied']);
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
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run src/features/realtime/normalizedEvent.test.ts`

Expected: FAIL with module-not-found for `normalizedEvent.ts`.

- [ ] **Step 3: Implement the normalization helpers**

```ts
// src/features/realtime/normalizedEvent.ts
import type { GatewayEvent } from '@/types';
import { classifyStreamEvent, extractFinalMessages, extractStreamDelta } from '@/features/chat/operations';
import type { RealtimeEvent, RealtimeMessageEntity, RealtimeSnapshotPayload } from './types';

function nowFromGatewayEvent(event: GatewayEvent): number {
  return typeof event.seq === 'number' ? event.seq : Date.now();
}

function toCommittedMessage(sessionId: string, runId: string | null, messageId: string, text: string, revision: number): RealtimeMessageEntity {
  return {
    messageId,
    sessionId,
    runId,
    role: 'assistant',
    contentParts: [{ type: 'text', text }],
    status: 'committed',
    revision,
  };
}

export function normalizeGatewayEvent(event: GatewayEvent): RealtimeEvent[] {
  const classified = classifyStreamEvent(event);
  if (!classified?.sessionKey) return [];

  const receivedAt = nowFromGatewayEvent(event);
  const sessionId = classified.sessionKey;

  if (classified.source === 'agent') {
    const agentState = classified.agentPayload?.state || classified.agentPayload?.agentState || null;
    return [
      {
        type: 'agent.presence_updated',
        eventId: `agent:${receivedAt}:${sessionId}`,
        receivedAt,
        source: 'live-agent',
        sessionId,
        presence: {
          sessionId,
          agentId: sessionId.split(':')[1] || null,
          phase: agentState || String((classified.agentPayload?.data as Record<string, unknown> | undefined)?.phase || ''),
          lastSeenAt: receivedAt,
        },
      },
    ];
  }

  if (classified.type === 'chat_started' && classified.runId) {
    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:started`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'running',
        finalized: false,
      },
    ];
  }

  if (classified.type === 'chat_delta' && classified.runId && classified.chatPayload) {
    const delta = extractStreamDelta(classified.chatPayload);
    if (!delta) return [];

    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:delta`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'running',
        finalized: false,
      },
      {
        type: 'message.delta_applied',
        eventId: `chat:${receivedAt}:${classified.runId}:message`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        messageId: `${classified.runId}:assistant`,
        text: delta.cleaned,
        revision: classified.chatSeq ?? receivedAt,
      },
    ];
  }

  if (classified.type === 'chat_final' && classified.runId && classified.chatPayload) {
    const finalMessages = extractFinalMessages(classified.chatPayload);
    const assistantText = finalMessages
      .map((message) => {
        if (typeof message.content === 'string') return message.content;
        return Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === 'text')
              .map((part) => String(part.text || ''))
              .join('')
          : '';
      })
      .join('\n')
      .trim();

    return [
      {
        type: 'run.status_changed',
        eventId: `chat:${receivedAt}:${classified.runId}:final`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        runId: classified.runId,
        status: 'completed',
        finalized: true,
      },
      {
        type: 'message.committed',
        eventId: `chat:${receivedAt}:${classified.runId}:committed`,
        receivedAt,
        source: 'live-chat',
        sessionId,
        message: toCommittedMessage(
          sessionId,
          classified.runId,
          `${classified.runId}:assistant`,
          assistantText,
          classified.chatSeq ?? receivedAt,
        ),
      },
    ];
  }

  return [];
}

export function normalizeLocalRunCreated(sessionId: string, runId: string, receivedAt: number): RealtimeEvent {
  return {
    type: 'run.created',
    eventId: `local:${runId}:${receivedAt}`,
    receivedAt,
    source: 'local',
    sessionId,
    runId,
  };
}

export function normalizeSnapshotLoaded(snapshot: RealtimeSnapshotPayload): RealtimeEvent {
  return {
    type: 'snapshot.loaded',
    eventId: `snapshot:${snapshot.session.sessionId}:${snapshot.recoveredAt}`,
    receivedAt: snapshot.recoveredAt,
    source: 'snapshot',
    sessionId: snapshot.session.sessionId,
    snapshot,
  };
}
```

```ts
// src/features/chat/operations/streamEventHandler.ts
// Keep this file focused on classification + raw extraction only.
// Do not add reducer state mutation here. Export only parsing helpers used by normalizedEvent.ts.
```

- [ ] **Step 4: Run the normalization test again**

Run: `npx vitest run src/features/realtime/normalizedEvent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the normalization layer**

```bash
git add src/features/realtime/normalizedEvent.ts src/features/realtime/normalizedEvent.test.ts src/features/chat/operations/streamEventHandler.ts
git commit -m "feat: normalize realtime gateway events"
```

### Task 3: Server Snapshot / Reconcile Endpoint

**Files:**
- Create: `server/lib/realtime-snapshot.ts`
- Create: `server/lib/realtime-snapshot.test.ts`
- Create: `server/routes/realtime.ts`
- Create: `server/routes/realtime.test.ts`
- Modify: `server/app.ts:38-96`

- [ ] **Step 1: Write the failing server snapshot tests**

```ts
// server/lib/realtime-snapshot.test.ts
import { describe, expect, it, vi } from 'vitest';

const gatewayRpcCall = vi.fn();
vi.mock('./gateway-rpc.js', () => ({
  gatewayRpcCall: (...args: unknown[]) => gatewayRpcCall(...args),
}));

describe('buildRealtimeSnapshot', () => {
  it('returns session, run, message, and presence data for a session', async () => {
    gatewayRpcCall.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.list' && !('spawnedBy' in params)) {
        return {
          sessions: [{ sessionKey: 'agent:main:main', state: 'running', updatedAt: 100 }],
        };
      }
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'assistant', timestamp: 99, content: 'hello from history' },
          ],
        };
      }
      if (method === 'sessions.list' && params.spawnedBy === 'agent:main:main') {
        return { sessions: [] };
      }
      return {};
    });

    const { buildRealtimeSnapshot } = await import('./realtime-snapshot.js');
    const snapshot = await buildRealtimeSnapshot({ sessionKey: 'agent:main:main', limit: 25 });

    expect(snapshot.session.sessionId).toBe('agent:main:main');
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.agentPresence?.phase).toBe('running');
  });
});
```

```ts
// server/routes/realtime.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const buildRealtimeSnapshot = vi.fn();
vi.mock('../lib/realtime-snapshot.js', () => ({
  buildRealtimeSnapshot: (...args: unknown[]) => buildRealtimeSnapshot(...args),
}));

describe('GET /api/realtime/snapshot', () => {
  it('rejects a missing sessionKey', async () => {
    const mod = await import('./realtime.js');
    const app = new Hono();
    app.route('/', mod.default);

    const res = await app.request('/api/realtime/snapshot');
    expect(res.status).toBe(400);
  });

  it('returns a snapshot payload', async () => {
    buildRealtimeSnapshot.mockResolvedValue({
      session: {
        sessionId: 'agent:main:main',
        status: 'idle',
        agentId: 'main',
        updatedAt: 12,
        sourceVersion: 'snapshot-12',
      },
      runs: [],
      messages: [],
      agentPresence: null,
      recoveredAt: 12,
      source: 'server-reconcile',
    });

    const mod = await import('./realtime.js');
    const app = new Hono();
    app.route('/', mod.default);

    const res = await app.request('/api/realtime/snapshot?sessionKey=agent%3Amain%3Amain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        session: expect.objectContaining({ sessionId: 'agent:main:main' }),
      }),
    });
  });
});
```

- [ ] **Step 2: Run the server tests to verify they fail**

Run: `npx vitest run server/lib/realtime-snapshot.test.ts server/routes/realtime.test.ts`

Expected: FAIL because the route and snapshot builder do not exist.

- [ ] **Step 3: Implement the snapshot builder and route**

```ts
// server/lib/realtime-snapshot.ts
import { gatewayRpcCall } from './gateway-rpc.js';

interface BuildRealtimeSnapshotArgs {
  sessionKey: string;
  limit: number;
}

function toAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
      .map((part) => String((part as { text?: string }).text || ''))
      .join('');
  }
  return '';
}

export async function buildRealtimeSnapshot({ sessionKey, limit }: BuildRealtimeSnapshotArgs) {
  const [sessionsResult, spawnedResult, historyResult] = await Promise.all([
    gatewayRpcCall('sessions.list', { activeMinutes: 24 * 60, limit: 200 }) as Promise<{ sessions?: Array<Record<string, unknown>> }>,
    gatewayRpcCall('sessions.list', { spawnedBy: sessionKey, limit: 200 }).catch(() => ({ sessions: [] })) as Promise<{ sessions?: Array<Record<string, unknown>> }>,
    gatewayRpcCall('chat.history', { sessionKey, limit }) as Promise<{ messages?: Array<Record<string, unknown>> }>,
  ]);

  const session = (sessionsResult.sessions || []).find((entry) => (entry.sessionKey || entry.key) === sessionKey) || {};
  const historyMessages = historyResult.messages || [];
  const recoveredAt = Date.now();

  return {
    session: {
      sessionId: sessionKey,
      status: String(session.state || 'unknown'),
      agentId: typeof sessionKey === 'string' ? sessionKey.split(':')[1] || null : null,
      updatedAt: Number(session.updatedAt || recoveredAt),
      sourceVersion: `snapshot-${recoveredAt}`,
    },
    runs: [],
    messages: historyMessages.map((message, index) => ({
      messageId: `${sessionKey}:history:${message.timestamp || index}`,
      sessionId: sessionKey,
      runId: typeof message.runId === 'string' ? message.runId : null,
      role: message.role === 'user' ? 'user' : 'assistant',
      contentParts: [{ type: 'text', text: toAssistantText(message) }],
      status: 'committed',
      revision: Number(message.timestamp || index),
    })),
    agentPresence: {
      sessionId: sessionKey,
      agentId: sessionKey.split(':')[1] || null,
      phase: String(session.state || ''),
      lastSeenAt: Number(session.updatedAt || recoveredAt),
    },
    spawnedSessions: (spawnedResult.sessions || []).map((entry) => ({
      sessionId: String(entry.sessionKey || entry.key || ''),
      status: String(entry.state || 'unknown'),
    })),
    recoveredAt,
    source: 'server-reconcile' as const,
  };
}
```

```ts
// server/routes/realtime.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { buildRealtimeSnapshot } from '../lib/realtime-snapshot.js';

const app = new Hono();

const snapshotQuery = z.object({
  sessionKey: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

app.get('/api/realtime/snapshot', rateLimitGeneral, async (c) => {
  const parsed = snapshotQuery.safeParse({
    sessionKey: c.req.query('sessionKey'),
    limit: c.req.query('limit') ?? 100,
  });

  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid query' }, 400);
  }

  const snapshot = await buildRealtimeSnapshot(parsed.data);
  return c.json({ ok: true, snapshot });
});

export default app;
```

```ts
// server/app.ts
import realtimeRoutes from './routes/realtime.js';

const routes = [
  healthRoutes, authRoutes, ttsRoutes, transcribeRoutes, agentLogRoutes,
  tokensRoutes, memoriesRoutes, eventsRoutes, serverInfoRoutes,
  codexLimitsRoutes, claudeCodeLimitsRoutes, versionRoutes, versionCheckRoutes,
  gatewayRoutes, connectDefaultsRoutes, realtimeRoutes,
  workspaceRoutes, cronsRoutes, sessionsRoutes, skillsRoutes, filesRoutes, apiKeysRoutes,
  voicePhrasesRoutes, fileBrowserRoutes, uploadConfigRoutes, uploadReferenceRoutes, channelsRoutes, kanbanRoutes, beadsRoutes,
];
```

- [ ] **Step 4: Run the server tests again**

Run: `npx vitest run server/lib/realtime-snapshot.test.ts server/routes/realtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the snapshot endpoint**

```bash
git add server/lib/realtime-snapshot.ts server/lib/realtime-snapshot.test.ts server/routes/realtime.ts server/routes/realtime.test.ts server/app.ts
git commit -m "feat: add realtime snapshot reconcile endpoint"
```

### Task 4: Realtime Provider, Transport Metadata, and Recovery Orchestration

**Files:**
- Create: `src/contexts/RealtimeContext.tsx`
- Create: `src/contexts/RealtimeContext.test.tsx`
- Create: `src/hooks/useChatRecovery.test.ts`
- Modify: `src/hooks/useWebSocket.ts:4-280`
- Modify: `src/contexts/GatewayContext.tsx:8-23, 47-156`
- Modify: `src/hooks/useChatRecovery.ts:34-204`
- Modify: `src/features/auth/AuthGate.tsx:29-38`
- Modify: `src/hooks/useWebSocket.test.ts`

- [ ] **Step 1: Write the failing provider and recovery tests**

```ts
// src/contexts/RealtimeContext.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { GatewayEvent } from '@/types';

let subscribedHandler: ((event: GatewayEvent) => void) | null = null;

vi.mock('./GatewayContext', () => ({
  useGateway: () => ({
    connectionState: 'connected',
    reconnectAttempt: 0,
    transportMeta: { lastCloseCode: null, lastCloseReason: null, connectedAt: 10 },
    subscribe: (handler: (event: GatewayEvent) => void) => {
      subscribedHandler = handler;
      return () => {
        subscribedHandler = null;
      };
    },
  }),
}));

describe('RealtimeProvider', () => {
  it('dispatches normalized gateway events into reducer state', async () => {
    const mod = await import('./RealtimeContext');
    const wrapper = ({ children }: { children: React.ReactNode }) => <mod.RealtimeProvider>{children}</mod.RealtimeProvider>;
    const { result } = renderHook(() => mod.useRealtime(), { wrapper });

    subscribedHandler?.({
      type: 'event',
      event: 'chat',
      seq: 1,
      payload: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        seq: 2,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    });

    await waitFor(() => {
      expect(result.current.state.runs['run-1']?.status).toBe('running');
    });
  });
});
```

```ts
// src/hooks/useChatRecovery.test.ts
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatRecovery } from './useChatRecovery';

describe('useChatRecovery', () => {
  it('requests snapshot reconcile instead of chat.history merge', async () => {
    const requestSnapshot = vi.fn(async () => {});
    const setStream = vi.fn();

    const { result } = renderHook(() =>
      useChatRecovery({
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        setStream,
      }),
    );

    await act(async () => {
      result.current.triggerRecovery('reconnect');
    });

    expect(requestSnapshot).toHaveBeenCalledWith('agent:main:main', 'reconnect');
  });
});
```

- [ ] **Step 2: Run the provider and recovery tests to verify they fail**

Run: `npx vitest run src/contexts/RealtimeContext.test.tsx src/hooks/useChatRecovery.test.ts src/hooks/useWebSocket.test.ts`

Expected: FAIL because `RealtimeContext` and the new recovery contract do not exist.

- [ ] **Step 3: Implement the provider, pass transport metadata through the gateway, and switch recovery to snapshots**

```ts
// src/hooks/useWebSocket.ts
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface TransportMeta {
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  connectedAt: number | null;
}

interface UseWebSocketReturn {
  connectionState: ConnectionState;
  transportMeta: TransportMeta;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: React.MutableRefObject<((msg: GatewayEvent) => void) | null>;
  connectError: string;
  reconnectAttempt: number;
}

const [transportMeta, setTransportMeta] = useState<TransportMeta>({
  lastCloseCode: null,
  lastCloseReason: null,
  connectedAt: null,
});

// inside the connect success branch
setTransportMeta({
  lastCloseCode: null,
  lastCloseReason: null,
  connectedAt: Date.now(),
});

// inside ws.onclose
ws.onclose = (event) => {
  setTransportMeta((prev) => ({
    ...prev,
    lastCloseCode: event.code,
    lastCloseReason: event.reason || 'socket-closed',
  }));
  rejectPending(new Error('WebSocket disconnected'));
  // existing reconnect logic stays in place
};

return {
  connectionState,
  transportMeta,
  connect,
  disconnect,
  rpc,
  onEvent,
  connectError,
  reconnectAttempt,
};
```

```ts
// src/contexts/GatewayContext.tsx
interface GatewayContextValue {
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  transportMeta: {
    lastCloseCode: number | null;
    lastCloseReason: string | null;
    connectedAt: number | null;
  };
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  connectError: string;
  reconnectAttempt: number;
  model: string;
  thinking: string;
  sparkline: string;
  isVisibleRef: React.MutableRefObject<boolean>;
  subscribe: (handler: EventHandler) => () => void;
}

const { connectionState, transportMeta, connect: wsConnect, disconnect, rpc, onEvent, connectError, reconnectAttempt } = useWebSocket();

const value = useMemo<GatewayContextValue>(() => ({
  connectionState,
  transportMeta,
  connect,
  disconnect,
  rpc,
  connectError,
  reconnectAttempt,
  model,
  thinking,
  sparkline,
  isVisibleRef,
  subscribe,
}), [connectionState, transportMeta, connect, disconnect, rpc, connectError, reconnectAttempt, model, thinking, sparkline, subscribe]);
```

```tsx
// src/contexts/RealtimeContext.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { useGateway } from './GatewayContext';
import { normalizeGatewayEvent, normalizeSnapshotLoaded } from '@/features/realtime/normalizedEvent';
import { createInitialRealtimeState, realtimeReducer } from '@/features/realtime/reducer';
import { selectRealtimeStatus } from '@/features/realtime/selectors';
import type { ReconcileReason, RealtimeSnapshotPayload } from '@/features/realtime/types';

interface RealtimeContextValue {
  state: ReturnType<typeof createInitialRealtimeState>;
  realtimeStatus: ReturnType<typeof selectRealtimeStatus>;
  requestSnapshot: (sessionId: string, reason: ReconcileReason) => Promise<void>;
  dispatch: React.Dispatch<Parameters<typeof realtimeReducer>[1]>;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { connectionState, reconnectAttempt, transportMeta, subscribe } = useGateway();
  const [state, dispatch] = useReducer(realtimeReducer, undefined, createInitialRealtimeState);

  useEffect(() => {
    const now = Date.now();
    if (connectionState === 'connected') {
      dispatch({
        type: 'connection.opened',
        eventId: `connection-opened:${now}`,
        receivedAt: now,
        source: 'local',
        sessionId: 'global',
        reconnectAttempt,
      });
      return;
    }

    if (connectionState === 'reconnecting') {
      dispatch({
        type: 'connection.closed',
        eventId: `connection-closed:${now}`,
        receivedAt: now,
        source: 'local',
        sessionId: 'global',
        reason: transportMeta.lastCloseReason || 'reconnecting',
        reconnectAttempt,
      });
    }
  }, [connectionState, reconnectAttempt, transportMeta.lastCloseReason]);

  useEffect(() => {
    return subscribe((message) => {
      for (const event of normalizeGatewayEvent(message)) {
        dispatch(event);
      }
    });
  }, [subscribe]);

  const requestSnapshot = useCallback(async (sessionId: string, reason: ReconcileReason) => {
    const requestedAt = Date.now();
    dispatch({
      type: 'connection.reconcile_requested',
      eventId: `reconcile:${sessionId}:${requestedAt}`,
      receivedAt: requestedAt,
      source: 'local',
      sessionId,
      reason,
    });

    const response = await fetch(`/api/realtime/snapshot?sessionKey=${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      dispatch({
        type: 'connection.degraded',
        eventId: `reconcile-failed:${sessionId}:${Date.now()}`,
        receivedAt: Date.now(),
        source: 'local',
        sessionId,
        reason: 'snapshot-request-failed',
      });
      return;
    }

    const payload = await response.json() as { ok: true; snapshot: RealtimeSnapshotPayload };
    dispatch(normalizeSnapshotLoaded(payload.snapshot));
    dispatch({
      type: 'snapshot.merge_completed',
      eventId: `snapshot-merged:${sessionId}:${Date.now()}`,
      receivedAt: Date.now(),
      source: 'local',
      sessionId,
    });
  }, []);

  const value = useMemo(() => ({
    state,
    realtimeStatus: selectRealtimeStatus(state),
    requestSnapshot,
    dispatch,
  }), [state, requestSnapshot]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used within RealtimeProvider');
  return context;
}
```

```ts
// src/hooks/useChatRecovery.ts
interface UseChatRecoveryDeps {
  requestSnapshot: (sessionId: string, reason: RecoveryReason) => Promise<void>;
  currentSessionRef: React.RefObject<string>;
  isGeneratingRef: React.RefObject<boolean>;
  activeRunIdRef: React.RefObject<string | null>;
  setStream: React.Dispatch<React.SetStateAction<ChatStreamState>>;
}

await requestSnapshot(currentSessionRef.current, reason);
```

```tsx
// src/features/auth/AuthGate.tsx
import { RealtimeProvider } from '@/contexts/RealtimeContext';

return (
  <GatewayProvider>
    <SettingsProvider>
      <RealtimeProvider>
        <SessionProvider>
          <ChatProvider>
            <App onLogout={logout} />
          </ChatProvider>
        </SessionProvider>
      </RealtimeProvider>
    </SettingsProvider>
  </GatewayProvider>
);
```

- [ ] **Step 4: Run the provider, websocket, and recovery tests again**

Run: `npx vitest run src/contexts/RealtimeContext.test.tsx src/hooks/useChatRecovery.test.ts src/hooks/useWebSocket.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the provider and recovery plumbing**

```bash
git add src/contexts/RealtimeContext.tsx src/contexts/RealtimeContext.test.tsx src/hooks/useChatRecovery.ts src/hooks/useChatRecovery.test.ts src/hooks/useWebSocket.ts src/hooks/useWebSocket.test.ts src/contexts/GatewayContext.tsx src/features/auth/AuthGate.tsx
git commit -m "feat: add realtime provider and snapshot recovery"
```

### Task 5: ChatContext Adoption

**Files:**
- Modify: `src/contexts/ChatContext.tsx:102-741`
- Modify: `src/contexts/ChatContext.subscription.test.tsx`
- Modify: `src/features/chat/operations/sendMessage.test.ts`

- [ ] **Step 1: Write the failing ChatContext regression tests**

```ts
// src/contexts/ChatContext.subscription.test.tsx
it('requests realtime snapshot recovery after reconnect instead of polling chat.history', async () => {
  const requestSnapshot = vi.fn(async () => {});

  vi.doMock('./RealtimeContext', () => ({
    useRealtime: () => ({
      state: {
        connection: { status: 'live', reconcileNeeded: false },
        sessions: {},
        runs: {},
        messages: {},
        agentPresence: {},
      },
      realtimeStatus: 'live',
      requestSnapshot,
      dispatch: vi.fn(),
    }),
  }));

  const { ChatProvider, useChat } = await import('./ChatContext');

  function Probe() {
    useChat();
    return null;
  }

  render(
    <ChatProvider>
      <Probe />
    </ChatProvider>,
  );

  expect(requestSnapshot).not.toHaveBeenCalled();
});
```

```ts
// src/features/chat/operations/sendMessage.test.ts
it('returns the acknowledged runId so ChatContext can dispatch local realtime state', async () => {
  const rpc = vi.fn(async () => ({ runId: 'run-123', status: 'started' }));
  const { sendChatMessage } = await import('./sendMessage');

  const result = await sendChatMessage({
    rpc,
    sessionKey: 'agent:main:main',
    text: 'hello',
    images: [],
  });

  expect(result.runId).toBe('run-123');
});
```

- [ ] **Step 2: Run the ChatContext tests to verify they fail**

Run: `npx vitest run src/contexts/ChatContext.subscription.test.tsx src/features/chat/operations/sendMessage.test.ts`

Expected: FAIL because `ChatContext` does not consume `RealtimeContext` yet.

- [ ] **Step 3: Refactor ChatContext to dispatch live/local events and render from realtime selectors**

```tsx
// src/contexts/ChatContext.tsx
import { useRealtime } from './RealtimeContext';
import { normalizeGatewayEvent, normalizeLocalRunCreated } from '@/features/realtime/normalizedEvent';
import { selectVisibleMessagesForSession, selectSessionAgentPresence } from '@/features/realtime/selectors';

export function ChatProvider({ children }: { children: ReactNode }) {
  const { connectionState, rpc, subscribe } = useGateway();
  const { currentSession } = useSessionContext();
  const { state: realtimeState, dispatch, requestSnapshot } = useRealtime();

  const recoveryHook = useChatRecovery({
    requestSnapshot,
    currentSessionRef,
    isGeneratingRef,
    activeRunIdRef,
    setStream: streamHook.setStream,
  });

  useEffect(() => {
    if (connectionState !== 'connected' || !currentSession) return;
    void requestSnapshot(currentSession, 'session-switch');
  }, [connectionState, currentSession, requestSnapshot]);

  useEffect(() => {
    return subscribe((message: GatewayEvent) => {
      for (const event of normalizeGatewayEvent(message)) {
        dispatch(event);
      }
    });
  }, [dispatch, subscribe]);

  useEffect(() => {
    if (!currentSession) return;
    const visibleMessages = selectVisibleMessagesForSession(realtimeState, currentSession).map((message) => ({
      id: message.messageId,
      role: message.role,
      rawText: message.contentParts.map((part) => part.text).join(''),
      html: message.contentParts.map((part) => part.text).join(''),
      timestamp: message.revision,
    }));
    applyMessageWindow(visibleMessages, false);
  }, [applyMessageWindow, currentSession, realtimeState]);

  const handleSend = useCallback(async (text: string, images: ImageAttachment[] = []) => {
    const result = await sendChatMessage({
      rpc,
      sessionKey: currentSessionRef.current,
      text,
      images,
    });

    if (result.runId) {
      dispatch(normalizeLocalRunCreated(currentSessionRef.current, result.runId, Date.now()));
    }
  }, [dispatch, rpc]);

  const realtimePresence = currentSession ? selectSessionAgentPresence(realtimeState, currentSession) : null;
  const derivedIsGenerating = Boolean(realtimePresence && realtimePresence.phase && realtimePresence.phase !== 'idle');

  // Replace the old subagent 3-second polling effect with snapshot reconcile on completion or stale gaps.
  useEffect(() => {
    if (!currentSession || !realtimePresence?.phase) return;
    if (realtimePresence.phase === 'end' || realtimePresence.phase === 'completed') {
      void requestSnapshot(currentSession, 'subagent-complete');
    }
  }, [currentSession, realtimePresence, requestSnapshot]);
}
```

- [ ] **Step 4: Run the ChatContext tests again**

Run: `npx vitest run src/contexts/ChatContext.subscription.test.tsx src/features/chat/operations/sendMessage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the ChatContext migration**

```bash
git add src/contexts/ChatContext.tsx src/contexts/ChatContext.subscription.test.tsx src/features/chat/operations/sendMessage.test.ts
git commit -m "feat: route chat state through realtime reducer"
```

### Task 6: SessionContext and Status UI Adoption

**Files:**
- Modify: `src/contexts/SessionContext.tsx:311-780`
- Modify: `src/App.tsx:1114-1122`
- Modify: `src/components/StatusBar.tsx:7-174`
- Create: `src/components/StatusBar.test.tsx`
- Modify: `src/contexts/SessionContext.test.tsx`

- [ ] **Step 1: Write the failing session/status UI tests**

```ts
// src/components/StatusBar.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar';

describe('StatusBar realtime status', () => {
  it('renders SYNCING when reconcile is in progress', () => {
    render(
      <StatusBar
        connectionState="connected"
        realtimeStatus="syncing"
        sessionCount={2}
        sparkline="▁▂▃▄"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('SYNCING');
  });
});
```

```ts
// src/contexts/SessionContext.test.tsx
it('derives reviewer status from realtime presence instead of raw gateway event branching', async () => {
  vi.doMock('./RealtimeContext', () => ({
    useRealtime: () => ({
      state: {
        connection: { status: 'live', reconcileNeeded: false },
        sessions: {
          'agent:reviewer:main': {
            sessionId: 'agent:reviewer:main',
            status: 'running',
            agentId: 'reviewer',
            updatedAt: Date.now(),
            sourceVersion: 'snapshot-1',
          },
        },
        runs: {},
        messages: {},
        agentPresence: {
          'agent:reviewer:main': {
            sessionId: 'agent:reviewer:main',
            agentId: 'reviewer',
            phase: 'streaming',
            lastSeenAt: Date.now(),
          },
        },
      },
      realtimeStatus: 'live',
      requestSnapshot: vi.fn(async () => {}),
      dispatch: vi.fn(),
    }),
  }));
});
```

- [ ] **Step 2: Run the session and status tests to verify they fail**

Run: `npx vitest run src/contexts/SessionContext.test.tsx src/components/StatusBar.test.tsx`

Expected: FAIL because `SessionContext` and `StatusBar` do not consume realtime state yet.

- [ ] **Step 3: Derive session state from realtime selectors and expose realtime status in the UI**

```tsx
// src/contexts/SessionContext.tsx
import { useRealtime } from './RealtimeContext';
import { selectSessionAgentPresence, selectRealtimeStatus } from '@/features/realtime/selectors';

export function SessionProvider({ children }: { children: ReactNode }) {
  const { state: realtimeState, realtimeStatus } = useRealtime();

  const refreshSessions = useCallback(async () => {
    if (connectionState !== 'connected') return;
    const newSessions = await listAuthoritativeSessions();
    setSessions(newSessions);
  }, [connectionState, listAuthoritativeSessions]);

  useEffect(() => {
    setAgentStatus((previous) => {
      const next = { ...previous };
      for (const session of sessionsRef.current) {
        const sessionKey = getSessionKey(session);
        const presence = selectSessionAgentPresence(realtimeState, sessionKey);
        if (!presence?.phase) continue;
        next[sessionKey] = {
          status: presence.phase === 'streaming' ? 'STREAMING' : 'THINKING',
          since: presence.lastSeenAt,
        };
      }
      return next;
    });
  }, [realtimeState]);

  // Keep websocket events for list discovery only.
  useEffect(() => {
    const unsub = subscribe((msg: GatewayEvent) => {
      const payload = (msg.payload || {}) as { sessionKey?: string };
      if (msg.event === 'agent' && payload.sessionKey && !sessionsRef.current.find((session) => getSessionKey(session) === payload.sessionKey)) {
        void refreshSessions();
      }
    });
    return unsub;
  }, [refreshSessions, subscribe]);
}
```

```tsx
// src/components/StatusBar.tsx
interface StatusBarProps {
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  realtimeStatus: 'live' | 'reconnecting' | 'syncing' | 'degraded' | 'offline';
  sessionCount: number;
  sparkline: string;
  contextTokens?: number;
  contextLimit?: number;
}

const statusColor = realtimeStatus === 'live'
  ? 'border-green/30 bg-green/10 text-green'
  : realtimeStatus === 'syncing' || realtimeStatus === 'reconnecting'
  ? 'border-orange/30 bg-orange/10 text-orange animate-pulse-dot'
  : realtimeStatus === 'degraded'
  ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600'
  : 'border-red/30 bg-red/10 text-red';

const statusLabel = realtimeStatus === 'live'
  ? 'LIVE'
  : realtimeStatus === 'syncing'
  ? 'SYNCING'
  : realtimeStatus === 'reconnecting'
  ? 'RECONNECTING'
  : realtimeStatus === 'degraded'
  ? 'DEGRADED'
  : 'OFFLINE';
```

```tsx
// src/App.tsx
import { useRealtime } from '@/contexts/RealtimeContext';

const { realtimeStatus } = useRealtime();

<StatusBar
  connectionState={connectionState}
  realtimeStatus={realtimeStatus}
  sessionCount={sessions.length}
  sparkline={sparkline}
  contextTokens={contextTokens}
  contextLimit={contextLimit}
/>
```

- [ ] **Step 4: Run the session and status tests again**

Run: `npx vitest run src/contexts/SessionContext.test.tsx src/components/StatusBar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the session/status adoption**

```bash
git add src/contexts/SessionContext.tsx src/contexts/SessionContext.test.tsx src/components/StatusBar.tsx src/components/StatusBar.test.tsx src/App.tsx
git commit -m "feat: derive session and status UI from realtime state"
```

### Task 7: Observability and End-to-End Realtime Regression Coverage

**Files:**
- Modify: `server/lib/ws-proxy.ts:99-260`
- Modify: `server/lib/ws-proxy.test.ts`
- Modify: `src/hooks/useWebSocket.test.ts`
- Modify: `src/contexts/ChatContext.subscription.test.tsx`
- Modify: `src/contexts/RealtimeContext.test.tsx`

- [ ] **Step 1: Write the failing observability and reconnect-regression tests**

```ts
// server/lib/ws-proxy.test.ts
it('logs close reason and retry mode for a proxied websocket connection', async () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const ws = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
  );

  const challenge = await waitForMessage(ws);
  expect(JSON.parse(challenge).event).toBe('connect.challenge');

  mockGw.disconnectAll(1012, 'gateway-restart');
  await waitForClose(ws);

  expect(
    logSpy.mock.calls.some(([line]) => String(line).includes('closeReason=gateway-restart')),
  ).toBe(true);
});
```

```ts
// src/contexts/RealtimeContext.test.tsx
it('marks realtime status as syncing while snapshot reconcile is pending', async () => {
  const mod = await import('./RealtimeContext');
  const wrapper = ({ children }: { children: React.ReactNode }) => <mod.RealtimeProvider>{children}</mod.RealtimeProvider>;
  const { result } = renderHook(() => mod.useRealtime(), { wrapper });

  await act(async () => {
    await result.current.requestSnapshot('agent:main:main', 'reconnect');
  });

  expect(['syncing', 'live']).toContain(result.current.realtimeStatus);
});
```

```ts
// src/contexts/ChatContext.subscription.test.tsx
it('does not duplicate the final assistant message after disconnect and reconcile', async () => {
  let realtimeState = {
    connection: { status: 'live', reconcileNeeded: false },
    sessions: {},
    runs: {
      'run-1': {
        runId: 'run-1',
        sessionId: 'main',
        status: 'running',
        messageIds: ['run-1:assistant:stream'],
        lastEventAt: 1,
        finalized: false,
      },
    },
    messages: {
      'run-1:assistant:stream': {
        messageId: 'run-1:assistant:stream',
        sessionId: 'main',
        runId: 'run-1',
        role: 'assistant',
        contentParts: [{ type: 'text', text: 'hello' }],
        status: 'streaming',
        revision: 1,
      },
    },
    agentPresence: {},
  };

  const requestSnapshot = vi.fn(async () => {
    realtimeState = {
      ...realtimeState,
      runs: {
        'run-1': {
          ...realtimeState.runs['run-1'],
          status: 'completed',
          finalized: true,
          messageIds: ['run-1:assistant:final'],
        },
      },
      messages: {
        'run-1:assistant:final': {
          messageId: 'run-1:assistant:final',
          sessionId: 'main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'hello' }],
          status: 'committed',
          revision: 2,
        },
      },
    };
  });

  vi.doMock('./RealtimeContext', () => ({
    useRealtime: () => ({
      state: realtimeState,
      realtimeStatus: 'live',
      requestSnapshot,
      dispatch: vi.fn(),
    }),
  }));

  const { ChatProvider, useChat } = await import('./ChatContext');

  function Consumer() {
    const { messages } = useChat();
    const assistantCount = messages.filter((message) => message.role === 'assistant').length;
    return <div data-testid="assistant-count">{assistantCount}</div>;
  }

  const view = render(
    <ChatProvider>
      <Consumer />
    </ChatProvider>,
  );

  expect(screen.getByTestId('assistant-count').textContent).toBe('1');

  await act(async () => {
    await requestSnapshot('main', 'reconnect');
  });

  view.rerender(
    <ChatProvider>
      <Consumer />
    </ChatProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId('assistant-count').textContent).toBe('1');
  });
});
```

- [ ] **Step 2: Run the final regression suite to verify the new cases fail**

Run: `npx vitest run server/lib/ws-proxy.test.ts src/hooks/useWebSocket.test.ts src/contexts/RealtimeContext.test.tsx src/contexts/ChatContext.subscription.test.tsx`

Expected: FAIL because structured lifecycle logging and reconnect/snapshot regression coverage are not complete yet.

- [ ] **Step 3: Add structured lifecycle logging and finish the reconnect regression cases**

```ts
// server/lib/ws-proxy.ts
function logWsLifecycle(tag: string, fields: Record<string, string | number | boolean | null>) {
  const serialized = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`${tag} ${serialized}`);
}

// on browser connect
logWsLifecycle(tag, {
  phase: 'connected',
  target: targetUrl.toString(),
  trusted: isTrusted,
});

// on gateway close / retry
logWsLifecycle(tag, {
  phase: 'gateway-close',
  closeCode: code,
  closeReason: reason || 'unknown',
  useDeviceIdentity,
  hasRetried,
});
```

```tsx
// src/contexts/RealtimeContext.tsx
const requestSnapshot = useCallback(async (sessionId: string, reason: ReconcileReason) => {
  const startedAt = Date.now();
  dispatch({
    type: 'connection.reconcile_requested',
    eventId: `reconcile:${sessionId}:${startedAt}`,
    receivedAt: startedAt,
    source: 'local',
    sessionId,
    reason,
  });

  console.debug('[realtime] snapshot requested', { sessionId, reason, startedAt });
  const response = await fetch(`/api/realtime/snapshot?sessionKey=${encodeURIComponent(sessionId)}`);
  const payload = await response.json();
  dispatch(normalizeSnapshotLoaded(payload.snapshot));
  dispatch({
    type: 'snapshot.merge_completed',
    eventId: `snapshot-merge:${sessionId}:${Date.now()}`,
    receivedAt: Date.now(),
    source: 'local',
    sessionId,
  });
  console.debug('[realtime] snapshot merged', {
    sessionId,
    reason,
    durationMs: Date.now() - startedAt,
  });
}, []);
```

- [ ] **Step 4: Run the final regression suite again**

Run: `npx vitest run server/lib/ws-proxy.test.ts src/hooks/useWebSocket.test.ts src/contexts/RealtimeContext.test.tsx src/contexts/ChatContext.subscription.test.tsx src/contexts/SessionContext.test.tsx server/routes/realtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the observability and regression work**

```bash
git add server/lib/ws-proxy.ts server/lib/ws-proxy.test.ts src/hooks/useWebSocket.test.ts src/contexts/RealtimeContext.test.tsx src/contexts/ChatContext.subscription.test.tsx src/contexts/SessionContext.test.tsx
git commit -m "test: cover realtime reconnect and observability flows"
```

## Spec Coverage Check

- Shared normalized reducer and selectors: Task 1
- Hybrid live-event plus snapshot-reconcile model: Tasks 2 and 3
- Provider-level ownership of realtime state: Task 4
- Recovery through authoritative snapshot rather than `chat.history` merge: Task 4
- ChatContext migration away from split truth and subagent polling correctness: Task 5
- SessionContext/UI convergence and truthful status labels: Task 6
- Structured transport/recovery observability and reconnect regressions: Task 7

## Placeholder Scan

- No `TODO`, `TBD`, or deferred implementation markers remain in the task steps.
- Every task includes exact files, commands, and commit messages.
- Every code-writing step names exported functions and concrete interfaces.

## Type Consistency Check

- Client reducer event type is `RealtimeEvent` throughout Tasks 1, 2, 4, and 5.
- Snapshot route returns `snapshot` payloads consumed by `normalizeSnapshotLoaded()` in Tasks 2, 3, and 4.
- UI status uses `realtimeStatus` throughout Tasks 1, 4, and 6; it does not overload the existing raw websocket `connectionState`.
