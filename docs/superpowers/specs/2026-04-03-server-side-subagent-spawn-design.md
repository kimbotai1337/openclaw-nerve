# Server-Side Subagent Spawn Design

Date: 2026-04-03
Branch: `jen/server-side-subagent-spawn`
Status: Draft for review

## Goal

Replace the frontend-only direct subagent spawn experiment with a server-owned launch path that preserves the behavior users already expect from the current marker-based flow while improving determinism.

Specifically, the new architecture must:
- keep subagent launch reliable even when marker-message spawning is flaky or delayed
- preserve `cleanup=delete`
- preserve the existing UX promise that child results report back into the selected parent root session
- avoid putting long-lived lifecycle logic in the React client

## Problem Statement

Current production behavior in `SessionContext` launches subagents indirectly:
1. build a `[spawn-subagent]` marker message
2. `chat.send` it to the selected parent root
3. poll `sessions.list` until a new child appears

This works on Sean’s local setup, but it is indirect and can time out if the parent/gateway does not process the marker quickly enough.

PR #223 tried to make launch deterministic by moving to `sessions.create` + `sessions.send` directly from the frontend. Smoke testing showed that the direct client-owned approach regressed two required behaviors:
- `cleanup=delete` no longer removed the child after completion
- the finished child no longer reported its result back to the parent root session

The root issue is architectural: `sessions.create` + `sessions.send` only handles launch. The remaining lifecycle behaviors (completion monitoring, parent reporting, cleanup, partial-failure cleanup) still need an owner, and the browser is the wrong place to own them.

## Recommended Architecture

Implement a dedicated server-side subagent spawn helper plus an HTTP route:
- helper: `server/lib/subagent-spawn.ts`
- route: `POST /api/sessions/spawn-subagent`

The React client will stop owning subagent lifecycle details. Instead it will:
1. resolve the desired parent root session as it does today
2. POST spawn parameters to the new route
3. refresh sessions
4. focus the returned child session key

The Nerve server will own:
- direct child creation via gateway RPC
- canonical child session key resolution
- initial task send + runId capture
- child completion monitoring in the background
- reporting completion/failure back into the parent root
- optional post-run child deletion
- best-effort cleanup of orphan children on partial launch failure
- fallback to legacy marker-message spawning when direct RPC spawn is unsupported

## Scope

### In scope
- add a server route for subagent spawning
- add a reusable server helper for direct child launch + monitoring
- migrate UI subagent spawn calls in `SessionContext` to the new route
- preserve current root-agent spawn logic (`kind: 'root'`) unchanged
- preserve current child discovery/focus UX from the client side
- add focused tests for route, helper, and client integration

### Out of scope
- introducing a new OpenClaw gateway RPC primitive
- changing top-level root creation behavior
- persisting subagent monitors across full Nerve server restarts
- changing the visible subagent configuration UI
- changing the existing marker-message contract beyond using it as fallback

## Route Contract

### Endpoint
`POST /api/sessions/spawn-subagent`

### Request body
```json
{
  "parentSessionKey": "agent:reviewer:main",
  "task": "Reply with exactly: OK",
  "label": "audit-auth-flow",
  "model": "codex-5.4",
  "thinking": "medium",
  "cleanup": "keep"
}
```

### Validation rules
- `parentSessionKey`: required string, must be a top-level root session key (`agent:<id>:main`)
- `task`: required non-empty string
- `label`: optional string
- `model`: optional string
- `thinking`: optional string or omitted
- `cleanup`: optional enum `keep | delete`, default `keep`

### Success response
```json
{
  "ok": true,
  "sessionKey": "agent:reviewer:subagent:uuid",
  "runId": "optional-run-id",
  "mode": "direct"
}
```

### Fallback success response
```json
{
  "ok": true,
  "sessionKey": "agent:reviewer:subagent:uuid",
  "mode": "marker"
}
```

### Failure shape
```json
{
  "ok": false,
  "error": "human-readable message"
}
```

## Server Helper Design

Create a helper that separates launch from monitoring.

### Launch phase
Primary path:
1. validate parent root session key format
2. generate a requested child key under that root
3. call `sessions.create`
4. resolve canonical child key from `createResponse.key ?? createResponse.sessionKey ?? requestedKey`
5. call `sessions.send` using the resolved child key
6. capture `runId` if returned
7. start a background completion monitor
8. return the resolved child key immediately to the caller

If `sessions.send` fails after create succeeds:
- best-effort delete the child transcript/session
- rethrow original send failure

### Unsupported-direct fallback
If direct spawn fails with a narrow unsupported-method signal (for example exact `unknown method: sessions.create` / `unknown method: sessions.send` style failures), the route should:
1. snapshot the visible session keys before sending the fallback marker
2. build the existing `[spawn-subagent]` marker message using the same `cleanup` semantics as today
3. `chat.send` it to the parent root
4. poll `sessions.list` to discover the new child under that root
5. return the discovered child key

### Marker fallback discovery heuristic
Reuse the current production discovery rule from `SessionContext` so fallback behavior stays aligned with the shipping UX:
- new child must satisfy `isSubagentSessionKey(sessionKey)`
- new child must satisfy `isRootChildSession(sessionKey, parentSessionKey)`
- new child must **not** be present in the pre-send session-key snapshot

This keeps fallback correlation stable when the parent already has existing children. If multiple subagents are launched close together, the route should only consider children that were absent before the fallback marker send for this request.

Important: do **not** use broad fallback matching like generic `invalid_request` or `not available`, because that can hide real launch bugs.

## Completion Monitor Design

The completion monitor is the missing piece that makes direct spawn match the original user-facing behavior.

### Responsibilities
For direct launches only, the monitor will:
1. poll `sessions.list` for the exact launched child session key
2. track whether the launched run has actually started before treating an idle child as complete
3. if failed, capture the failure text
4. if completed, fetch recent child history with `sessions.get`
5. extract the assistant result for the launched run, not an unrelated later manual message
6. send a completion/failure report to the parent root via `sessions.send`
7. if `cleanup=delete`, delete the child session after reporting

### Correlation / completion rules
- The monitor is anchored to the exact resolved child session key returned by launch.
- If `runId` is available from the initial `sessions.send` ack, it should be carried through the monitor as the strongest correlation hint.
- The monitor must not treat a freshly created child that is still idle as completed before there is evidence that the launched run started.
- Evidence of start can come from either the captured `runId` showing up in session state/history, or the child session transitioning through a busy/processing/working phase after launch.
- Result extraction should prefer the assistant output associated with the launched run; when explicit run correlation is unavailable, use the launch timestamp plus child session key as the fallback boundary so later manual follow-up messages are not mistaken for the spawned task result.

### Parent report format
Mirror the Kanban report style, but scoped to general subagent spawning. Example:

```text
Subagent child session completion report.

Use this as context from work that ran under this root. This is a completion update, not a fresh task unless follow-up is needed.

Parent root: agent:reviewer:main
Child session: agent:reviewer:subagent:uuid
Label: audit-auth-flow
Outcome: completed

Result:
...
```

Failure reports use `Outcome: failed` and include the error block instead of result text.

### Cleanup ordering
For `cleanup=delete`, the order must be:
1. fetch child result/error
2. send parent completion report
3. best-effort delete child transcript/session

This preserves report-back semantics even when the child is meant to disappear from the sidebar.

## Client Changes

`src/contexts/SessionContext.tsx`
- keep root agent spawn path as-is
- replace subagent direct RPC / marker logic with a `fetch('/api/sessions/spawn-subagent')`
- on success:
  - `refreshSessions()`
  - `setCurrentSession(response.sessionKey)`
- surface route errors directly to the caller

The client will no longer:
- call `sessions.create` for subagent spawns
- call `sessions.send` for subagent spawns
- own fallback logic for unsupported direct spawn
- own completion monitoring
- own cleanup semantics for direct launches

## Reuse / Precedent

This design deliberately copies the parts of the Kanban implementation that already solved the same problem on the server side:
- canonical child session key resolution
- runId capture
- completion/failure polling
- parent-root completion reporting
- best-effort orphan cleanup

We are not reusing Kanban’s task store logic, but we are reusing its lifecycle ownership model.

## File-Level Plan

### New files
- `server/lib/subagent-spawn.ts`
  - launch helper
  - monitor helper
  - report builder
- `server/lib/subagent-spawn.test.ts`

### Existing files to update
- `server/routes/sessions.ts`
  - add `POST /api/sessions/spawn-subagent`
- `server/routes/sessions.test.ts`
  - add route-level tests
- `server/app.ts`
  - no path changes expected if route stays inside `sessions.ts`
- `src/contexts/SessionContext.tsx`
  - use HTTP route for child spawn
- `src/contexts/SessionContext.test.tsx`
  - replace direct-RPC expectations with HTTP route expectations

## Testing Plan

### Server helper tests
- resolves canonical key returned by `sessions.create`
- deletes orphan child when `sessions.send` fails after create
- reports completion back to parent on successful completion
- reports failure back to parent on child error
- deletes child after report when `cleanup=delete`
- keeps child when `cleanup=keep`

### Route tests
- rejects invalid body / invalid parent root key
- returns direct success payload when direct launch works
- falls back to marker mode only on exact unsupported-direct errors
- returns discovered child key after marker fallback
- propagates real direct-launch errors without hiding them behind fallback

### Client tests
- subagent spawn calls `/api/sessions/spawn-subagent`
- successful route response refreshes sessions and switches current session to returned child
- route failure surfaces cleanly
- root spawn path still uses `agents.create` + `chat.send` and remains unchanged

### Manual smoke tests
1. **Keep mode**
   - spawn child under non-main root
   - child completes
   - child remains visible
   - parent root receives completion report
2. **Delete mode**
   - spawn child under non-main root
   - child completes
   - parent root receives completion report
   - child disappears afterward
3. **Failure path**
   - launch child that errors
   - parent receives failure report
4. **Fallback path**
   - simulate unsupported direct methods
   - marker spawn still works

## Risks and Mitigations

### Risk: background monitor leaks or duplicates
Mitigation:
- key monitors by child session key
- short-circuit if a monitor for that child is already active
- stop polling after terminal handling or timeout

### Risk: server-side polling adds extra load
Mitigation:
- reuse existing polling intervals/patterns from Kanban
- only poll for direct launches
- stop immediately once terminal state is observed

### Risk: hiding real gateway bugs with fallback
Mitigation:
- narrow fallback detection to exact unsupported-method signatures
- propagate all other direct-path errors

### Risk: route returns before session becomes visible in sidebar
Mitigation:
- direct launch returns the canonical child key immediately
- client still refreshes sessions after success
- if needed, route can optionally do one short confirmation poll before responding

## Success Criteria

This work is successful when:
- direct subagent spawn no longer depends on marker-message processing in the happy path
- `cleanup=delete` works again
- parent-root completion reporting works again
- fallback behavior preserves compatibility on unsupported gateways
- the lifecycle logic lives on the server, not in React

## Open Questions

None blocking.

The exact helper name and whether the route lives inside `sessions.ts` or a dedicated route file can be finalized during implementation as long as the API path stays stable and the lifecycle ownership remains server-side.
