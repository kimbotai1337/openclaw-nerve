import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEARTBEAT_REASONS,
  TELEMETRY_FEATURE_NAMES,
  computeActive24h,
  emptyFeaturesUsed24h,
  type HeartbeatReason,
  type TelemetryFeatureName,
  type TelemetryWindowSnapshot,
} from './types.js';

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const STATE_SCHEMA_VERSION = 1;

interface Phase1State {
  schemaVersion: number;
  counts: {
    sessionsCreatedAt: string[];
    messagesSentAt: string[];
    toolCallsAt: string[];
  };
  featureLastUsedAt: Partial<Record<TelemetryFeatureName, string>>;
  seenSessionHashes: string[];
  heartbeats: {
    lastSentAtByReason: Partial<Record<HeartbeatReason, string>>;
    lastAppVersion?: string;
  };
}

export interface TelemetryStoreOptions {
  telemetryDir?: string;
  stateFile?: string;
}

export interface RecordToolCompletedInput {
  toolName: string;
  success: boolean;
  startedAt: number;
  finishedAt: number;
  occurredAt?: Date | string | number;
}

export interface NoteHeartbeatSentInput {
  reason: HeartbeatReason;
  sentAt: Date | string | number;
  appVersion: string;
}

export interface MarkSessionSeenResult {
  firstSeen: boolean;
  sessionHash: string;
}

export interface TelemetryStore {
  recordSessionCreated(at?: Date | string | number): Promise<void>;
  recordMessageSubmitted(at?: Date | string | number): Promise<void>;
  recordToolCompleted(input: RecordToolCompletedInput): Promise<void>;
  markFeatureUsed(feature: TelemetryFeatureName, at?: Date | string | number): Promise<void>;
  markSessionSeen(sessionKey: string): Promise<MarkSessionSeenResult>;
  clearSessionSeen(sessionKey: string): Promise<void>;
  readWindow(now?: Date | string | number): Promise<TelemetryWindowSnapshot>;
  noteHeartbeatSent(input: NoteHeartbeatSentInput): Promise<void>;
}

function defaultStateFile(): string {
  const home = process.env.HOME || os.homedir();
  const telemetryDir = process.env.NERVE_TELEMETRY_DIR || path.join(home, '.nerve', 'telemetry');
  return path.join(telemetryDir, 'phase1-state.json');
}

function resolveStateFile(options: TelemetryStoreOptions): string {
  if (options.stateFile) return options.stateFile;
  if (options.telemetryDir) return path.join(options.telemetryDir, 'phase1-state.json');
  return defaultStateFile();
}

function createDefaultState(): Phase1State {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    counts: {
      sessionsCreatedAt: [],
      messagesSentAt: [],
      toolCallsAt: [],
    },
    featureLastUsedAt: {},
    seenSessionHashes: [],
    heartbeats: {
      lastSentAtByReason: {},
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function parseHeartbeatReason(value: unknown): HeartbeatReason | undefined {
  return HEARTBEAT_REASONS.includes(value as HeartbeatReason) ? (value as HeartbeatReason) : undefined;
}

function parseFeatureName(value: unknown): TelemetryFeatureName | undefined {
  return TELEMETRY_FEATURE_NAMES.includes(value as TelemetryFeatureName)
    ? (value as TelemetryFeatureName)
    : undefined;
}

function parseTimestampArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseTimestamp)
    .filter((entry): entry is string => !!entry)
    .sort();
}

function sanitizeState(value: unknown): Phase1State {
  if (!isObject(value)) return createDefaultState();

  const counts = isObject(value.counts) ? value.counts : {};
  const featureLastUsedAt = isObject(value.featureLastUsedAt) ? value.featureLastUsedAt : {};
  const heartbeats = isObject(value.heartbeats) ? value.heartbeats : {};
  const lastSentAtByReason = isObject(heartbeats.lastSentAtByReason) ? heartbeats.lastSentAtByReason : {};

  const sanitizedFeatures: Partial<Record<TelemetryFeatureName, string>> = {};
  for (const [key, rawValue] of Object.entries(featureLastUsedAt)) {
    const feature = parseFeatureName(key);
    const timestamp = parseTimestamp(rawValue);
    if (feature && timestamp) sanitizedFeatures[feature] = timestamp;
  }

  const sanitizedLastSentAtByReason: Partial<Record<HeartbeatReason, string>> = {};
  for (const [key, rawValue] of Object.entries(lastSentAtByReason)) {
    const reason = parseHeartbeatReason(key);
    const timestamp = parseTimestamp(rawValue);
    if (reason && timestamp) sanitizedLastSentAtByReason[reason] = timestamp;
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    counts: {
      sessionsCreatedAt: parseTimestampArray(counts.sessionsCreatedAt),
      messagesSentAt: parseTimestampArray(counts.messagesSentAt),
      toolCallsAt: parseTimestampArray(counts.toolCallsAt),
    },
    featureLastUsedAt: sanitizedFeatures,
    seenSessionHashes: Array.isArray(value.seenSessionHashes)
      ? value.seenSessionHashes.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [],
    heartbeats: {
      lastSentAtByReason: sanitizedLastSentAtByReason,
      lastAppVersion: typeof heartbeats.lastAppVersion === 'string' && heartbeats.lastAppVersion
        ? heartbeats.lastAppVersion
        : undefined,
    },
  };
}

function resolveAt(value?: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function sessionHash(sessionKey: string): string {
  return `sha256:${crypto.createHash('sha256').update(sessionKey).digest('hex')}`;
}

function pruneState(state: Phase1State, nowIso: string): Phase1State {
  const nowMs = Date.parse(nowIso);
  const windowStartMs = nowMs - ROLLING_WINDOW_MS;

  const pruneTimestamps = (timestamps: string[]) => timestamps.filter((entry) => {
    const entryMs = Date.parse(entry);
    return entryMs >= windowStartMs;
  });

  state.counts.sessionsCreatedAt = pruneTimestamps(state.counts.sessionsCreatedAt);
  state.counts.messagesSentAt = pruneTimestamps(state.counts.messagesSentAt);
  state.counts.toolCallsAt = pruneTimestamps(state.counts.toolCallsAt);

  for (const feature of TELEMETRY_FEATURE_NAMES) {
    const timestamp = state.featureLastUsedAt[feature];
    if (!timestamp) continue;

    const entryMs = Date.parse(timestamp);
    if (entryMs < windowStartMs) {
      delete state.featureLastUsedAt[feature];
    }
  }

  return state;
}

function buildSnapshot(state: Phase1State, nowIso: string): TelemetryWindowSnapshot {
  const nowMs = Date.parse(nowIso);
  const windowStart = new Date(nowMs - ROLLING_WINDOW_MS).toISOString();
  const windowStartMs = Date.parse(windowStart);

  const counts24h = {
    sessions_created: state.counts.sessionsCreatedAt.length,
    messages_sent: state.counts.messagesSentAt.length,
    tool_calls: state.counts.toolCallsAt.length,
  };

  const featuresUsed24h = emptyFeaturesUsed24h();
  for (const feature of TELEMETRY_FEATURE_NAMES) {
    const timestamp = state.featureLastUsedAt[feature];
    if (!timestamp) continue;

    const entryMs = Date.parse(timestamp);
    if (entryMs >= windowStartMs && entryMs <= nowMs) {
      featuresUsed24h[feature] = true;
    }
  }

  return {
    windowStart,
    windowEnd: nowIso,
    counts24h,
    featuresUsed24h,
    active24h: computeActive24h(counts24h, featuresUsed24h),
    lastHeartbeatSentAtByReason: { ...state.heartbeats.lastSentAtByReason },
    lastHeartbeatAppVersion: state.heartbeats.lastAppVersion,
  };
}

export function createTelemetryStore(options: TelemetryStoreOptions = {}): TelemetryStore {
  const stateFile = resolveStateFile(options);
  let queue = Promise.resolve();

  async function readState(): Promise<Phase1State> {
    try {
      const raw = await fs.readFile(stateFile, 'utf8');
      return sanitizeState(JSON.parse(raw));
    } catch {
      return createDefaultState();
    }
  }

  async function writeState(state: Phase1State): Promise<void> {
    await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function update(mutator: (state: Phase1State) => void | Phase1State, now?: Date | string | number): Promise<Phase1State> {
    const nowIso = resolveAt(now);
    const state = pruneState(await readState(), nowIso);
    const nextState = mutator(state) || state;
    pruneState(nextState, nowIso);
    await writeState(nextState);
    return nextState;
  }

  return {
    async recordSessionCreated(at) {
      await enqueue(async () => {
        const nowIso = resolveAt(at);
        await update((state) => {
          state.counts.sessionsCreatedAt.push(nowIso);
          state.featureLastUsedAt.sessions = nowIso;
        }, nowIso);
      });
    },

    async recordMessageSubmitted(at) {
      await enqueue(async () => {
        const nowIso = resolveAt(at);
        await update((state) => {
          state.counts.messagesSentAt.push(nowIso);
          state.featureLastUsedAt.chat = nowIso;
        }, nowIso);
      });
    },

    async recordToolCompleted(input) {
      await enqueue(async () => {
        const nowIso = resolveAt(input.occurredAt);
        await update((state) => {
          state.counts.toolCallsAt.push(nowIso);
          state.featureLastUsedAt.chat = nowIso;
        }, nowIso);
      });
    },

    async markFeatureUsed(feature, at) {
      await enqueue(async () => {
        const nowIso = resolveAt(at);
        await update((state) => {
          state.featureLastUsedAt[feature] = nowIso;
        }, nowIso);
      });
    },

    async markSessionSeen(sessionKey) {
      return enqueue(async () => {
        const nowIso = new Date().toISOString();
        const hash = sessionHash(sessionKey);
        let firstSeen = false;

        await update((state) => {
          if (!state.seenSessionHashes.includes(hash)) {
            state.seenSessionHashes.push(hash);
            firstSeen = true;
          }
        }, nowIso);

        return { firstSeen, sessionHash: hash };
      });
    },

    async clearSessionSeen(sessionKey) {
      await enqueue(async () => {
        const nowIso = new Date().toISOString();
        const hash = sessionHash(sessionKey);

        await update((state) => {
          state.seenSessionHashes = state.seenSessionHashes.filter((entry) => entry !== hash);
        }, nowIso);
      });
    },

    async readWindow(now) {
      return enqueue(async () => {
        const nowIso = resolveAt(now);
        const state = await update((current) => current, nowIso);
        return buildSnapshot(state, nowIso);
      });
    },

    async noteHeartbeatSent(input) {
      await enqueue(async () => {
        const sentAt = resolveAt(input.sentAt);
        await update((state) => {
          state.heartbeats.lastSentAtByReason[input.reason] = sentAt;
          state.heartbeats.lastAppVersion = input.appVersion;
        }, sentAt);
      });
    },
  };
}
