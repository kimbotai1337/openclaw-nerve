# Nerve Realtime + OpenClaw End-to-End Design

Date: 2026-04-22
Status: Draft for review
Branch: `realtime-e2e-openclaw-spec`

## Objective

Define an end-to-end realtime contract for Nerve chat and agent/session state when OpenClaw is the backend control plane, then specify the first implementation slice that materially improves seamlessness without a protocol rewrite.

The target user experience is:

- chat messages appear once and in order
- active runs stream smoothly through reconnects
- session and agent state converge to backend truth after gaps
- subagent activity does not rely on blind polling
- the UI can explain whether it is live, degraded, reconnecting, or reconciling

## Problem Summary

Nerve already has a working websocket path:

`Browser -> Nerve /ws proxy -> OpenClaw gateway`

The main weakness is not raw transport. The weakness is split state ownership:

- `ChatContext` owns chat-run streaming behavior and some recovery decisions
- `SessionContext` separately owns session refresh and convergence
- `useChatRecovery` rebuilds state from `chat.history`
- active subagent state still falls back to polling
- reconnect behavior is transport-aware but not driven by a single client-side source of truth

OpenClaw makes this more visible because its gateway is a control plane, not a replay broker:

- `chat.send` is asynchronous and returns a `runId`
- live state arrives through events
- event delivery is not a durable replay contract
- clients must reconcile from authoritative backend state after gaps

That means Nerve needs one normalized realtime model above both live events and recovery snapshots.

## Design Goals

1. Preserve the current browser-to-proxy-to-OpenClaw transport for slice one.
2. Make one client-side reducer the single owner of realtime chat/session/run state.
3. Treat live `chat` and `agent` events as the primary low-latency stream.
4. Treat session-oriented snapshot/reconcile data as the authoritative recovery path.
5. Make reconnects explicit, observable, and user-visible.
6. Remove state drift between chat state, session state, and backend truth.
7. Keep the design compatible with future adoption of `sessions.subscribe` and `sessions.messages.subscribe`.

## Non-Goals

- No full server-owned event broker rewrite.
- No OpenClaw protocol changes.
- No broad chat UI redesign.
- No attempt to make missed websocket events replayable from the client alone.
- No full migration to `sessions.subscribe` in slice one.

## Approaches Considered

### 1. Stay on current `chat` and `agent` streams only

Pros:

- smallest protocol change
- easiest local adoption

Cons:

- does not solve authoritative recovery
- keeps `chat.history` overextended as a convergence mechanism
- session truth remains fragmented

### 2. Migrate immediately to session-native subscriptions everywhere

Pros:

- aligns most directly with OpenClaw session authority
- may simplify long-term convergence

Cons:

- higher blast radius
- risks coupling slice one to protocol surfaces Nerve does not yet model well
- unnecessary migration pressure before the state layer is fixed

### 3. Hybrid model: live `chat` and `agent` stream plus authoritative session reconcile

Pros:

- lowest-risk path to better behavior
- fits the current Nerve transport and UI model
- fixes the real problem: split ownership and weak convergence
- keeps future session-subscription migration possible

Cons:

- requires careful normalization logic
- two source families must be merged explicitly

### Recommendation

Choose approach 3.

## Proposed Architecture

### Source of Truth Model

There are three layers:

1. **Transport layer**
   Browser websocket client and Nerve websocket proxy maintain connectivity to OpenClaw.

2. **Realtime normalization layer**
   A single client-side reducer ingests all live events, reconcile snapshots, and connection lifecycle signals.

3. **View layer**
   `ChatContext`, `SessionContext`, and chat UI selectors read from the normalized realtime state instead of building separate truths.

### Authoritative Semantics

- OpenClaw remains the backend source of truth.
- Live `chat` and `agent` events are the preferred low-latency updates.
- Reconcile snapshots win when the client detects a gap, reconnect, stale state, or uncertain ordering.
- UI state is derived from normalized entities, not directly from raw websocket event handling.

## Realtime Domain Model

The client reducer owns these normalized entities:

- `connection`
  - `status`: `connecting | live | degraded | reconnecting | offline`
  - `transport`: websocket/proxy health
  - `lastLiveAt`
  - `lastDisconnectReason`
  - `reconcileNeeded`

- `session`
  - `sessionId`
  - `status`
  - `agentId`
  - `updatedAt`
  - `sourceVersion`

- `run`
  - `runId`
  - `sessionId`
  - `status`: `queued | running | completed | failed | interrupted | unknown`
  - `messageIds`
  - `lastEventAt`
  - `finalized`

- `message`
  - stable `messageId`
  - `role`
  - `contentParts`
  - `runId`
  - `sessionId`
  - `status`: `streaming | committed | superseded`
  - `revision`

- `agentPresence`
  - active agent/subagent identity
  - current phase or status if known
  - `lastSeenAt`

The reducer must be able to rebuild the screen from these entities alone.

## Normalized Event Contract

All raw inputs are mapped into one internal event family:

- `connection.opened`
- `connection.degraded`
- `connection.closed`
- `connection.reconnect_scheduled`
- `connection.reconcile_requested`
- `session.upserted`
- `session.status_changed`
- `run.created`
- `run.status_changed`
- `message.delta_applied`
- `message.committed`
- `message.reconciled`
- `agent.presence_updated`
- `agent.run_linked`
- `snapshot.loaded`
- `snapshot.merge_completed`

Each normalized event includes:

- `eventId`
- `receivedAt`
- `source`: `live-chat | live-agent | snapshot | local`
- `sessionId`
- `runId` when applicable
- ordering metadata from the raw payload when available
- enough payload to update reducer state deterministically

## Ordering and Merge Rules

OpenClaw event delivery should be treated as low-latency but not durable. The reducer therefore follows these rules:

1. A live event can advance an entity optimistically if it is monotonic.
2. A snapshot can overwrite uncertain or stale live state if the snapshot is newer or marks a run/session terminal.
3. Terminal run states are sticky unless a newer snapshot explicitly contradicts them.
4. Message deltas are attached only to the active message for a run; once a committed message arrives, earlier streaming placeholders become superseded.
5. If ordering cannot be proven after reconnect, mark `reconcileNeeded` and fetch a snapshot rather than guessing.

## Connection Lifecycle

The client-visible lifecycle is:

1. `connecting`
2. `live`
3. `degraded`
   Entered when the websocket is up but event freshness or subscription certainty is compromised.
4. `reconnecting`
5. `reconciling`
   Represented by `reconcileNeeded=true` while snapshot recovery is in progress.
6. `live` again after merge, or `offline` if recovery fails completely

The UI should surface this state with plain labels and avoid pretending the session is live when it is only partially trustworthy.

## Run Lifecycle

For chat sends:

1. user submits message locally
2. OpenClaw `chat.send` returns `runId`
3. reducer records `run.created`
4. live `chat` or `agent` events stream message/running status
5. terminal live event or authoritative snapshot finalizes the run

If the websocket disconnects mid-run:

1. keep the run visible as in-progress but uncertain
2. mark `reconcileNeeded`
3. reconnect transport
4. request session snapshot
5. merge the authoritative run and message state
6. finalize or resume live streaming from the merged state

## Recovery and Reconciliation

Slice one replaces chat-history-driven recovery as the primary truth path.

### Recovery triggers

- websocket reconnect after any disconnect
- browser tab returns from background after freshness timeout
- send acknowledged but no matching live run activity within timeout
- session status appears stale relative to user action
- active run enters uncertain ordering state

### Recovery path

1. client dispatches `connection.reconcile_requested`
2. Nerve calls a new server reconcile endpoint
3. server asks OpenClaw for authoritative session/run/message state
4. server returns a normalized snapshot payload
5. client dispatches `snapshot.loaded`
6. reducer merges snapshot and clears stale placeholders

### Snapshot expectations

The snapshot must contain enough state to fully recover:

- session identity and status
- active agent/subagent identity if known
- active and recent runs for the current chat view
- committed messages for those runs
- terminality information
- server timestamp and source freshness metadata

`chat.history` may still be used as an input, but not as the sole recovery contract.

## Server Responsibilities

Nerve server responsibilities in slice one:

- keep the existing `/ws` proxy behavior
- preserve OpenClaw connection challenge handling and device retry behavior
- expose a new reconcile endpoint for current session/chat state
- normalize backend snapshot payloads into a stable client contract
- emit structured logs for connect, disconnect, reconnect, reconcile, and merge reasons

The server is not an event broker in slice one. It remains a transport and reconcile adapter.

## Client Responsibilities

### New modules

- `src/features/realtime/normalizedEvent.ts`
  - map raw websocket and snapshot payloads into normalized events

- `src/features/realtime/reducer.ts`
  - own normalized realtime entities and merge logic

- `src/features/realtime/selectors.ts`
  - expose chat/session/run selectors to existing contexts and components

- `src/features/realtime/types.ts`
  - reducer state, entity shapes, lifecycle enums

### Integration points

- `src/contexts/ChatContext.tsx`
  - stop owning raw run convergence rules
  - read run/message state from selectors
  - dispatch send lifecycle and live event inputs to realtime reducer

- `src/contexts/SessionContext.tsx`
  - stop independently deciding session truth after delayed refreshes
  - derive session state from the realtime reducer plus explicit session fetches when needed

- `src/hooks/useChatRecovery.ts`
  - become a reconcile trigger/orchestrator, not a transcript reconstruction owner

- `src/hooks/useWebSocket.ts`
  - dispatch explicit connection lifecycle signals

- `src/features/chat/operations/streamEventHandler.ts`
  - narrow responsibility to raw event classification and mapping into normalized events

### UI surface

- `StatusBar` or equivalent should expose:
  - live
  - reconnecting
  - syncing
  - degraded

The goal is truthfulness, not extra chrome.

## Slice-One Implementation Boundary

Slice one is complete when the following are true:

1. One reducer owns realtime session/run/message state.
2. `ChatContext` and `SessionContext` consume shared normalized state instead of maintaining separate convergence logic.
3. Mid-run reconnect causes reconcile-based recovery instead of transcript-only guesswork.
4. Active subagent/session state no longer depends on blind 3-second polling for correctness.
5. Connection and recovery status are observable in logs and visible in the UI.

### Files in scope

- `src/features/realtime/normalizedEvent.ts`
- `src/features/realtime/reducer.ts`
- `src/features/realtime/selectors.ts`
- `src/features/realtime/types.ts`
- `src/contexts/ChatContext.tsx`
- `src/contexts/SessionContext.tsx`
- `src/hooks/useChatRecovery.ts`
- `src/hooks/useWebSocket.ts`
- `src/features/chat/operations/streamEventHandler.ts`
- `server/routes/realtime.ts`
- `server/lib/realtime-snapshot.ts`
- `server/lib/ws-proxy.ts`
- `src/components/StatusBar.tsx` or the nearest existing connection-status surface

### Explicitly deferred

- full migration to `sessions.subscribe`
- cross-tab shared realtime state
- offline draft persistence
- generalized event persistence on the Nerve server

## Observability

Every reconnect and reconcile path must be explainable. Add structured fields for:

- `sessionId`
- `runId`
- websocket connection id
- disconnect reason
- reconnect attempt count
- reconcile trigger reason
- snapshot age
- merge result
- terminal run resolution source: live event vs snapshot

Add client metrics or logs for:

- time from disconnect to live restored
- time from reconnect to snapshot merge complete
- sends that required recovery before terminal state
- duplicate or superseded message corrections

## Error Handling

The design should handle these cases explicitly:

- send acknowledged with `runId` but no live events arrive
- websocket reconnects after terminal event was missed
- session status changes while chat view is backgrounded
- duplicate delta events
- agent handoff/subagent state changes without a visible chat message
- snapshot arrives after newer live data
- reconcile endpoint failure while websocket transport is healthy

Fallback rule:

If the client cannot prove correctness from live ordering, prefer visible degraded state plus reconcile over silent guessing.

## Testing Strategy

### Unit tests

- normalized event mapping from raw `chat`, `agent`, and snapshot payloads
- reducer merge semantics for terminality, duplicate deltas, and snapshot overwrite rules
- selectors for active session, active run, visible messages, and agent presence

### Integration tests

- send message, stream response, finalize run
- disconnect mid-run, reconnect, reconcile, finalize correctly
- session status change reflected consistently in chat and session surfaces
- subagent activity reflected without polling-driven correctness
- duplicate live events do not create duplicate messages

### Failure-injection tests

- delayed terminal event
- reconnect before send acknowledgment settles
- stale snapshot returned after newer live update
- reconcile endpoint temporary failure

## Acceptance Criteria

The user experience is considered seamless enough for slice one when:

- no duplicate assistant messages appear during reconnect or recovery
- active runs either continue streaming or resolve via reconcile within a bounded time
- session status shown in chat matches session status shown elsewhere in the app
- agent/subagent state is consistent across chat header, status surfaces, and session views
- the UI can always indicate whether it is live, reconnecting, or syncing
- logs are sufficient to explain any failed convergence

## Future-Compatible Extension Path

This design intentionally leaves room to move more of the live subscription model toward OpenClaw session-native subscriptions later.

If Nerve later adopts `sessions.subscribe` or `sessions.messages.subscribe`, the migration should change only:

- raw event subscriptions
- mapping logic in `normalizedEvent.ts`

It should not require a rewrite of the reducer, selectors, or UI state ownership model.

## Open Questions Resolved for Slice One

- **Primary live stream:** keep current `chat` and `agent` event families
- **Authoritative recovery:** use server-mediated session snapshot/reconcile
- **State ownership:** move to one normalized reducer
- **Transport:** keep current `/ws` proxy path
- **Polling:** reduce it from correctness path to optional fallback/telemetry only

## Implementation Decision

Proceed with a hybrid realtime architecture:

- keep the current websocket transport and live event families
- add a normalized client-side realtime state layer
- add a server reconcile snapshot contract
- make session-based recovery authoritative after uncertainty

This is the smallest change that addresses the real source of unreliability while staying aligned with OpenClaw’s architecture.
