# OpenClaw Chat Protocol Notes

Nerve receives OpenClaw chat state from two different sources:

- Realtime gateway frames delivered over the proxied WebSocket at `/ws?target=...`.
- Durable transcript snapshots returned by the `chat.history` RPC.

The UI must not treat those as separate render paths. Both sources should be
normalized into the same per-session timeline model before rendering.

## Gateway Frame Shapes

Gateway events use this outer shape:

```json
{
  "type": "event",
  "event": "chat",
  "seq": 42,
  "payload": {}
}
```

The installed OpenClaw gateway observed for this work emits `chat` payloads with:

- `state: "delta"` for live assistant text snapshots.
- `state: "final"` for terminal successful chat frames.
- `state: "error"` for terminal failures.
- `state: "aborted"` for aborted runs.

Tool and lifecycle activity arrives as `event: "agent"` with payload fields:

- `stream: "lifecycle"` and `data.phase: "start" | "end" | "error"`.
- `stream: "assistant"` and `data.text` for raw assistant activity.
- `stream: "tool"` and `data.phase: "start" | "result"`.

## Timeline Rules

The timeline reducer is responsible for these invariants:

- A streaming assistant response and its final transcript message are the same
  logical timeline position.
- Tool call bubbles are timeline items, not activity-log-only state.
- History recovery merges into existing state without deleting older bubbles that
  are absent from a short recovered tail.
- Replaying the same event is idempotent.
- Events for other sessions are ignored by a session-scoped reducer, but the app
  should keep a store per session so inactive runs can keep progressing.

## Durability

Completed transcript content is rebuilt from `chat.history`. In-flight UI state
is recovered from Nerve's live timeline ledger when available. Browser storage is
allowed to cache the selected session and recent timeline projection, but it is
not the source of truth for completed chat history.
