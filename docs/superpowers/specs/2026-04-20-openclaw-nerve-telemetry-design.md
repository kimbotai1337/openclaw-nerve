# OpenClaw Nerve Telemetry Design

## Summary

OpenClaw Nerve needs product visibility without violating the trust expectations of a self-hosted open source UI. This design adds a staged telemetry system with three server-controlled modes: `off`, `minimal`, and `detailed`.

The rollout is intentionally phased. Phase 1 provides anonymous instance heartbeat data plus aggressively scrubbed server-side error reporting to `telemetry.nerve.zone`. Phase 2 adds explicit opt-in, instance-level product analytics routed through Nerve and sent to `analytics.nerve.zone`.

This is one telemetry initiative, but delivery is deliberately staged. Implementation planning should treat Phase 1 as the required initial slice and Phase 2 as a follow-on slice on the same contract, not a day-one all-at-once build.

## Goals

- Measure how many active Nerve installs exist.
- Understand release adoption across fresh installs and upgrades.
- Distinguish the two supported install channels: `release` and `source`.
- Learn whether major product areas are used at all.
- Detect release quality regressions from aggregated error data.
- Add richer product analytics later without changing the privacy contract.
- Keep the public trust story simple, explicit, and defensible.

## Non-Goals

- Tracking individual users, accounts, or identities.
- Collecting chat content, prompts, filenames, paths, or tool payloads.
- Providing a user-facing analytics dashboard inside Nerve in this project.
- Supporting arbitrary third-party telemetry endpoints in the initial design.
- Building a full self-hostable analytics collector story in the first release.
- Turning telemetry failures into user-facing errors or startup blockers.

## Locked Product Decisions

### Telemetry Modes

Nerve exposes three server-side modes:

- `off`
- `minimal`
- `detailed`

Server config is the only control surface.

### Default Behavior

- Fresh installs default to `minimal`.
- Upgrades preserve existing behavior and do not silently enable telemetry.
- If an upgraded install has no existing telemetry setting because it predates this feature, Nerve treats that state as `off` until an admin explicitly configures telemetry.
- `detailed` is always explicit opt-in.

This behavior must be driven by a deterministic bootstrap marker, not inference.

Required contract:

- fresh install flows must write a local telemetry bootstrap marker declaring `fresh_install`
- the first release that introduces telemetry must write a local bootstrap marker declaring `upgrade_legacy` when it detects an existing install with no telemetry setting
- if no explicit telemetry mode exists and no trusted fresh-install marker is present, Nerve must fail safe to `off`

This prevents silent enablement on upgraded pre-telemetry installs.

### Install Channels

Nerve supports only these install methods:

- `release`: installed from the latest release flow triggered by the curl installer
- `source`: cloned and built from the GitHub repository

The design should not invent broader install-method categories.

### Infrastructure Shape

- Phase 1 data is sent to `telemetry.nerve.zone`.
- Phase 2 data is sent to `analytics.nerve.zone`.
- Both domains are first-party Nerve infrastructure.
- No alternate endpoint override is part of the initial design.

### Tracking Model

- Telemetry is instance-level only.
- There is no per-user tracking, even pseudonymous.
- There is one stable anonymous `instance_id` per install.

### Trust Posture

- Fresh installs show a visible first-run informational notice when `minimal` is active.
- The notice explains what is collected and points to server config for disabling telemetry.
- Nerve publishes a fully transparent public telemetry document with exact fields, payload examples, domains, and disable instructions.

## Privacy Contract

### Data That May Never Leave the Box

The telemetry pipeline must never send:

- chat text
- prompts
- tool input or output payloads
- filenames
- filesystem paths
- repository names
- auth headers
- cookies
- environment variable values
- freeform request bodies
- user identifiers
- usernames or email addresses
- raw exception context blobs that can contain any of the above

This restriction applies to both Phase 1 and Phase 2.

### Allowlist Rule for Error Reporting

Because server error reporting is included in `minimal`, error telemetry uses an allowlist model, not a blocklist model.

Only explicitly approved fields may be serialized and sent. Unknown fields are dropped.

## Identity and Install Metadata

### Stable Anonymous Instance ID

Every install has one stable anonymous `instance_id`.

Requirements:

- generated once on first run if missing
- persisted locally
- survives upgrades
- resets on reinstall or explicit local reset
- never derived from hostname, IP, username, or machine serial

### Install Method

The install method contract is:

- `release`
- `source`
- `unknown` only as a fallback when the expected stamp is missing or unreadable

Preferred approach:

- the curl-based release installer stamps `release`
- source builds stamp `source`
- runtime falls back to `unknown` only if the stamp is unavailable

The design should favor explicit stamping over heuristic detection.

## Phase 1: Minimal Telemetry

### Purpose

Phase 1 answers the core operational questions:

- how many active installs exist
- which versions are active
- what install channel they came from
- whether major product areas are used at all
- whether a release correlates with increased failures

### Phase 1 Runtime Responsibilities in Nerve

Each Nerve server includes a small telemetry subsystem that handles:

1. identity bootstrap
2. install metadata loading
3. local aggregate counter storage
4. daily heartbeat scheduling
5. scrubbed server-side error reporting

### Local Aggregate State

Nerve maintains persistent rolling aggregate telemetry state locally. The implementation may use a small JSON file or lightweight database, but the contract is local persistence of aggregate counters and feature booleans.

Phase 1 tracks these 24-hour aggregates:

- `sessions_created`
- `messages_sent`
- `tool_calls`

Phase 1 tracks these coarse feature booleans:

- `chat`
- `sessions`
- `branches`
- `kanban`
- `settings`

Boolean semantics:

- each boolean starts `false` for a new trailing 24-hour window
- a boolean flips to `true` when at least one qualifying action for that product area occurs within the active window
- qualifying actions must be defined by Nerve-owned instrumentation rules, not custom user data
- once `true`, a boolean stays `true` until the window rolls forward and the local aggregate store recomputes the next trailing 24-hour snapshot

Initial qualifying actions:

- `chat`: at least one message submitted or assistant response appended in chat
- `sessions`: at least one session created, opened, renamed, or deleted
- `branches`: at least one branch switch or branch creation action
- `kanban`: at least one Kanban task create, move, or complete action
- `settings`: at least one settings save action

These values are aggregate only. No event stream or content history is preserved locally for telemetry purposes.

### Heartbeat Schedule

Nerve sends a heartbeat:

- shortly after first boot or first-seen initialization
- once every 24 hours with jitter
- once after an app-version change is detected

All Phase 1 heartbeats are snapshot records, not deltas.

Required semantics:

- `counts_24h` and `features_used_24h` always describe the trailing 24-hour window ending at `sent_at`
- heartbeat payloads must include a machine-readable reason such as `first_seen`, `daily`, or `version_change`
- only heartbeats with `reason = daily` are eligible to feed daily usage rollups for `counts_24h` and `features_used_24h`
- `first_seen` and `version_change` heartbeats are operational snapshots for install discovery and version-observation only; they do not add usage volume to daily aggregate reporting
- if multiple `daily` heartbeats exist for the same `instance_id` on the same UTC day, the latest accepted `daily` heartbeat wins for that day and earlier same-day `daily` heartbeats are ignored in rollups
- the collector must never sum overlapping trailing windows from the same `instance_id`

Reporting interpretation:

- install-activity dashboards may count any accepted heartbeat for presence and last-seen purposes
- usage-volume dashboards must use only canonical `daily` snapshots after same-day deduplication

Telemetry sending is best effort:

- asynchronous
- bounded
- non-blocking
- safe to skip on failure

### Phase 1 Heartbeat Payload

Required payload shape:

```json
{
  "schema_version": 1,
  "instance_id": "uuid",
  "app_version": "1.5.2",
  "install_method": "release",
  "reason": "daily",
  "sent_at": "2026-04-20T20:00:00Z",
  "window_start": "2026-04-19T20:00:00Z",
  "window_end": "2026-04-20T20:00:00Z",
  "active_24h": true,
  "counts_24h": {
    "sessions_created": 8,
    "messages_sent": 54,
    "tool_calls": 17
  },
  "features_used_24h": {
    "chat": true,
    "sessions": true,
    "branches": false,
    "kanban": true,
    "settings": false
  }
}
```

This payload is intentionally boring. It is designed to be useful without creating surveillance creep.

### Phase 1 Error Reporting

Phase 1 error reporting is server-side only.

The initial design does not include frontend crash reporting. That keeps the trust boundary simpler and reduces the chance of leaking browser-side payloads.

Allowed fields:

- `schema_version`
- `instance_id`
- `app_version`
- `install_method`
- `error_kind`
- `error_code`
- `surface`
- `fingerprint`
- `occurred_at`

Optionally allowed if it can be proven scrubbed and safe:

- sanitized stack hash
- truncated sanitized stack signature

Not allowed:

- request bodies
- prompts
- chat text
- headers
- cookies
- file paths
- environment values
- arbitrary exception metadata blobs

Example payload:

```json
{
  "schema_version": 1,
  "instance_id": "uuid",
  "app_version": "1.5.2",
  "install_method": "release",
  "error_kind": "server_exception",
  "error_code": "E_SESSION_LOAD_FAILED",
  "surface": "sessions_api",
  "fingerprint": "sha256:abc123",
  "occurred_at": "2026-04-20T20:03:00Z"
}
```

### Phase 1 Collector Infrastructure

#### `telemetry.nerve.zone`

`telemetry.nerve.zone` hosts a small first-party ingestion system, not a full analytics suite.

Required components:

- HTTPS reverse proxy
- small collector service
- Postgres
- rollup worker or scheduled aggregation job
- private maintainer-facing dashboard

#### Phase 1 Endpoints

Required API surface:

- `POST /v1/heartbeat`
- `POST /v1/error`
- `GET /healthz`

No public query API is required.

#### Collector Behavior

The collector must:

- validate request schema strictly
- reject unknown fields in strict mode
- enforce request size caps
- apply rate limiting
- dedupe obvious duplicate heartbeats
- dedupe repeated identical errors when useful for storage hygiene
- store raw accepted records for short retention
- produce aggregate rollups for reporting

#### Retention

Recommended retention policy:

- raw heartbeats: 30 to 90 days
- raw errors: 30 days
- daily rollups: 12 months or longer

## Phase 2: Detailed Telemetry

### Purpose

Phase 2 adds opt-in product analytics that are still instance-level only. It exists to answer feature adoption and workflow questions that Phase 1 cannot answer cleanly.

Examples:

- Are installs actually using branches?
- Are installs creating Kanban tasks?
- How often do installs complete tool-call workflows?
- Which versions show lower completion rates for important actions?

### Activation Rule

Phase 2 activates only when telemetry mode is `detailed`.

`minimal` does not send Phase 2 product events.

`detailed` includes the Phase 1 `minimal` telemetry contract plus the approved Phase 2 detailed events.

### Event Ownership

Each detailed event has a single owner to avoid duplicate counting.

Initial ownership:

- `session_created` → server
- `message_submitted` → server
- `tool_call_completed` → server
- `branch_switched` → client, but relayed through the Nerve backend
- `kanban_task_created` → server

### No Direct Browser Egress

Even for UI-originated events, the browser does not send analytics directly to `analytics.nerve.zone`.

Flow:

1. UI emits a tiny local event to Nerve
2. Nerve validates and normalizes the event
3. Nerve forwards the sanitized event to `analytics.nerve.zone`

This keeps the privacy boundary on the Nerve server and maintains server-config-only control.

### Phase 2 Event Schema

Example payload:

```json
{
  "schema_version": 1,
  "event": "tool_call_completed",
  "instance_id": "uuid",
  "app_version": "1.5.2",
  "install_method": "release",
  "sent_at": "2026-04-20T20:10:00Z",
  "properties": {
    "surface": "chat",
    "tool_name": "edit",
    "success": true,
    "duration_bucket": "1_5s"
  }
}
```

Allowed initial properties:

- `surface`
- `tool_name`
- `success`
- `duration_bucket`
- `feature_area`

All Phase 2 property values must come from bounded enums or coarse buckets owned by Nerve. Raw freeform values are not allowed.

Initial value rules:

- `surface` must be one of: `chat`, `sessions`, `kanban`, `workspace`, `settings`
- `tool_name` must be one of the fixed coarse telemetry families: `read`, `write`, `edit`, `exec`, `browser`, `web`, `message`, `memory`, `image`, `video`, `pdf`, `session_ops`, `other`
- raw custom tool names, MCP tool names, and user-defined identifiers must never leave the box
- unknown or unmapped tools must be coerced to `other`
- `success` must be boolean
- `duration_bucket` must be one of: `lt_1s`, `1_5s`, `5_30s`, `gt_30s`
- `feature_area` must be one of: `chat`, `sessions`, `kanban`, `workspace`, `settings`

Unknown properties are rejected by Nerve before forwarding and rejected again by the analytics relay if they somehow reach it.
Unknown property values or out-of-taxonomy values are also rejected unless the contract explicitly says they are coerced to a named coarse fallback.

### Initial Phase 2 Event Set

The initial detailed event set is intentionally limited to five events:

- `session_created`
- `message_submitted`
- `tool_call_completed`
- `branch_switched`
- `kanban_task_created`

This keeps the first detailed analytics slice focused on core usage plus differentiated product features.

### Phase 2 Infrastructure

#### `analytics.nerve.zone`

`analytics.nerve.zone` hosts:

- HTTPS reverse proxy
- small ingestion relay
- self-hosted PostHog behind the relay
- internal dashboards for maintainers

Required Phase 2 API surface:

- `POST /v1/events`
- `GET /healthz`

The relay is responsible for schema validation, request-size enforcement, and rejecting payloads that contain unknown properties before forwarding data into PostHog.

Recommended Phase 2 retention policy:

- raw accepted relay payloads: 30 days
- PostHog detailed events: 90 days
- aggregate dashboards or rollups derived from them: 12 months or longer

## Control Surface and UX

### Server Config Only

Telemetry mode is controlled only from server config. The UI does not own the source of truth.

### Fresh Install Notice

Fresh installs that start in `minimal` mode show a first-run informational notice that:

- states telemetry is enabled in minimal mode
- explains what is collected at a high level
- links to the public telemetry document
- explains how to disable telemetry through server config

The notice is informational, not a toggle panel.

### Public Documentation Requirement

Nerve must publish a public telemetry document that includes:

- telemetry modes
- exact fields per mode
- sample payloads
- exact domains contacted
- the explicit list of data never collected
- disable instructions
- crash reporting behavior
- retention policy

This document is part of the product contract.

## Reliability Requirements

Telemetry must never be allowed to break core product behavior.

Requirements:

- no startup blocking on telemetry services
- no request blocking on telemetry sends
- bounded retry behavior
- bounded queue or buffer growth
- silent degradation if telemetry infrastructure is unavailable
- no user-facing failure noise for telemetry transport problems

## Rollout Plan

### Milestone 1: Contract and Local Plumbing

Ship inside Nerve:

- telemetry mode contract
- stable anonymous instance ID
- install method stamping contract
- local aggregate counter store
- coarse feature booleans
- strict error scrubber
- initial docs draft

### Milestone 2: Phase 1 Collector

Ship `telemetry.nerve.zone` with:

- heartbeat ingest endpoint
- error ingest endpoint
- health endpoint
- storage and rollups
- private maintainer dashboard

### Milestone 3: Phase 1 End-to-End

Wire Nerve to send:

- first-seen heartbeat
- daily heartbeat with jitter
- version-change heartbeat
- scrubbed server error reports
- fresh install informational notice

### Milestone 4: Observation Window

Run Phase 1 alone for a period before rolling out Phase 2 to explicitly opted-in `detailed` environments. Use this window to validate the trust story, payload hygiene, and practical usefulness of the aggregate data.

### Milestone 5: Phase 2

Ship:

- analytics relay
- self-hosted PostHog
- the initial five approved detailed events
- strict property allowlists
- instance-level-only reporting

## Testing Strategy

### Unit Tests

Required unit coverage:

- `instance_id` creation and persistence
- install method stamping and fallback handling
- 24-hour aggregate counter rollups
- feature boolean rollups
- heartbeat payload generation
- error scrubber allowlist behavior
- detailed-event property allowlist behavior
- guarantees that forbidden fields never enter telemetry payloads

### Integration Tests

Required integration coverage:

- `off` mode sends nothing
- `minimal` sends heartbeat and scrubbed server errors only
- `detailed` adds only the approved detailed events
- duplicate heartbeats are handled correctly
- transport failures do not block product behavior
- browser-originated Phase 2 events are relayed through Nerve instead of sent directly out of the browser

### Manual Verification

Required manual checks:

- fresh release install defaults to `minimal`
- fresh source install defaults to `minimal`
- upgraded installs with no prior telemetry setting stay `off` until explicitly configured
- upgrades do not silently enable telemetry
- first-run notice appears with accurate disclosure
- disabling telemetry via server config works as documented
- telemetry infrastructure outages do not affect normal Nerve usage

## Documentation Impact

The telemetry initiative should update:

- `README.md`
- `docs/CONFIGURATION.md`
- `docs/INSTALL.md`
- `docs/UPDATING.md`
- `docs/TELEMETRY.md`

`docs/TELEMETRY.md` is required and should be treated as a public contract document, not optional extra documentation.

## Risks and Tradeoffs

- Default-on `minimal` telemetry for fresh installs creates real trust risk unless the disclosure and documentation are excellent.
- Including server error reporting in `minimal` is useful, but only if the scrubber is aggressively conservative.
- Instance-level-only detailed analytics are less rich than user-level analytics, but much more appropriate for self-hosted OSS.
- Using first-party Nerve domains simplifies the trust story, but also creates an obligation to be precise and consistent about what those services do.
- Supporting both Phase 1 and Phase 2 in one initiative adds planning complexity, which is why execution should remain staged.

## Success Criteria

The design is successful when:

- maintainers can see active install counts and version adoption from Phase 1
- maintainers can distinguish `release` and `source` installs with clean data
- maintainers can observe coarse product-area usage without collecting user content
- telemetry failures never degrade the core app
- public documentation makes the trust contract easy to understand
- Phase 2 can be enabled later without reopening the core privacy decisions
