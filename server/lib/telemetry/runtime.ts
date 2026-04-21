import { config } from '../config.js';
import { buildErrorPayload } from './error-reporting.js';
import { buildHeartbeatPayload, nextDailyHeartbeatAt, shouldSendFirstSeen, shouldSendVersionChange } from './heartbeat.js';
import {
  ensureInstanceId,
  ensureLegacyUpgradeMarker,
  readBootstrapMarker,
  readInstallMethod,
  readInstallMethodOrUnknown,
  resolveTelemetryMode,
  type BootstrapMarker,
  type InstallMethod,
  type InstallMethodStamp,
  type TelemetryMode,
} from './install-metadata.js';
import { createTelemetryStore, type RecordToolCompletedInput, type TelemetryStore } from './store.js';
import { createTelemetryHttpTransport, type TelemetryTransport } from './http.js';
import type { TelemetryFeatureName, HeartbeatReason } from './types.js';

const DEFAULT_DAILY_JITTER_MS = 10 * 60 * 1000;

export interface TelemetryMetadataApi {
  ensureInstanceId(createdAt?: string): string;
  ensureLegacyUpgradeMarker(params?: { envMode?: string | null; stampedAt?: string }): BootstrapMarker | undefined;
  readBootstrapMarker(): BootstrapMarker | undefined;
  readInstallMethod(): InstallMethodStamp | undefined;
  readInstallMethodOrUnknown(stamp?: InstallMethodStamp): InstallMethod;
  resolveTelemetryMode(params: { envMode?: string | null; bootstrap?: BootstrapMarker }): TelemetryMode;
}

export interface ReportTelemetryErrorInput {
  error: unknown;
  surface?: string;
  errorCode?: string;
  occurredAt?: Date | string | number;
}

export interface TelemetryServerInfoDisclosure {
  telemetryMode: TelemetryMode;
  telemetryEnabled: boolean;
  telemetryPublicDocUrl: string;
  showFreshInstallNotice: boolean;
}

export interface TelemetryRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMode(): TelemetryMode;
  getServerInfoDisclosure(): TelemetryServerInfoDisclosure;
  recordSessionCreated(at?: Date | string | number): Promise<void>;
  recordMessageSubmitted(at?: Date | string | number): Promise<void>;
  recordToolCompleted(input: RecordToolCompletedInput): Promise<void>;
  markFeatureUsed(feature: TelemetryFeatureName, at?: Date | string | number): Promise<void>;
  reportError(input: ReportTelemetryErrorInput): Promise<void>;
}

export interface CreateTelemetryRuntimeOptions {
  appVersion: string;
  envMode?: string | null;
  telemetryDir?: string;
  phase1BaseUrl?: string;
  publicDocUrl?: string;
  store?: TelemetryStore;
  transport?: TelemetryTransport;
  metadata?: TelemetryMetadataApi;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  dailyJitterMs?: number;
}

const defaultMetadata: TelemetryMetadataApi = {
  ensureInstanceId,
  ensureLegacyUpgradeMarker,
  readBootstrapMarker,
  readInstallMethod,
  readInstallMethodOrUnknown,
  resolveTelemetryMode,
};

let activeTelemetryRuntime: TelemetryRuntime | null = null;

function createDefaultStore(options: CreateTelemetryRuntimeOptions): TelemetryStore {
  return createTelemetryStore({ telemetryDir: options.telemetryDir || config.telemetryDir });
}

function createDefaultTransport(options: CreateTelemetryRuntimeOptions): TelemetryTransport {
  return createTelemetryHttpTransport({
    baseUrl: options.phase1BaseUrl || config.telemetryPhase1BaseUrl,
  });
}

function resolveSurface(surface?: string): string {
  return surface || 'server';
}

export function getTelemetryRuntime(): TelemetryRuntime | null {
  return activeTelemetryRuntime;
}

export function setTelemetryRuntime(runtime: TelemetryRuntime | null): void {
  activeTelemetryRuntime = runtime;
}

export function createTelemetryRuntime(options: CreateTelemetryRuntimeOptions): TelemetryRuntime {
  const store = options.store || createDefaultStore(options);
  const transport = options.transport || createDefaultTransport(options);
  const metadata = options.metadata || defaultMetadata;
  const now = options.now || (() => new Date());
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const dailyJitterMs = options.dailyJitterMs ?? DEFAULT_DAILY_JITTER_MS;
  const envMode = options.envMode ?? config.telemetryModeRaw;
  const publicDocUrl = options.publicDocUrl || config.telemetryPublicDocUrl;

  let instanceId = '';
  let installMethod: InstallMethod = 'unknown';
  let bootstrap: BootstrapMarker | undefined;
  let mode: TelemetryMode = 'off';
  let started = false;
  let stopped = false;
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;

  function clearDailyTimer(): void {
    if (dailyTimer !== undefined) {
      clearTimeoutFn(dailyTimer);
      dailyTimer = undefined;
    }
  }

  function runInBackground(work: Promise<void>): void {
    void work.catch(() => {});
  }

  async function sendHeartbeat(reason: HeartbeatReason, sentAt = now()): Promise<void> {
    if (mode === 'off' || !instanceId) {
      return;
    }

    try {
      const snapshot = await store.readWindow(sentAt);
      const payload = buildHeartbeatPayload({
        identity: { instanceId },
        installMethod,
        appVersion: options.appVersion,
        reason,
        sentAt: sentAt.toISOString(),
        snapshot,
      });

      const delivered = await transport.postJson('/v1/heartbeat', payload);
      if (!delivered) {
        return;
      }

      await store.noteHeartbeatSent({
        reason,
        sentAt: payload.sent_at,
        appVersion: options.appVersion,
      });
    } catch {
      return;
    }
  }

  function scheduleDailyHeartbeat(): void {
    clearDailyTimer();

    if (mode === 'off' || stopped) {
      return;
    }

    const current = now();
    const target = nextDailyHeartbeatAt(current, dailyJitterMs);
    const delayMs = Math.max(0, target.getTime() - current.getTime());

    dailyTimer = setTimeoutFn(() => {
      runInBackground((async () => {
        if (mode === 'off' || stopped) {
          return;
        }

        await sendHeartbeat('daily', now());
        if (!stopped) {
          scheduleDailyHeartbeat();
        }
      })());
    }, delayMs);
  }

  async function initialize(): Promise<void> {
    const stampedAt = now().toISOString();
    instanceId = metadata.ensureInstanceId(stampedAt);
    bootstrap = metadata.readBootstrapMarker() || metadata.ensureLegacyUpgradeMarker({ envMode, stampedAt });
    const installMethodStamp = metadata.readInstallMethod();
    installMethod = metadata.readInstallMethodOrUnknown(installMethodStamp);
    mode = metadata.resolveTelemetryMode({ envMode, bootstrap });
  }

  async function sendStartupHeartbeats(): Promise<void> {
    if (mode === 'off') {
      return;
    }

    const snapshot = await store.readWindow(now());

    if (shouldSendFirstSeen(snapshot.lastHeartbeatSentAtByReason)) {
      await sendHeartbeat('first_seen', now());
      return;
    }

    if (shouldSendVersionChange({
      appVersion: options.appVersion,
      lastHeartbeatAppVersion: snapshot.lastHeartbeatAppVersion,
    })) {
      await sendHeartbeat('version_change', now());
    }
  }

  function telemetryEnabled(): boolean {
    return mode !== 'off';
  }

  return {
    async start() {
      if (started && !stopped) {
        return;
      }

      started = true;
      stopped = false;
      await initialize();

      if (!telemetryEnabled()) {
        clearDailyTimer();
        return;
      }

      scheduleDailyHeartbeat();
      runInBackground(sendStartupHeartbeats());
    },

    async stop() {
      stopped = true;
      started = false;
      clearDailyTimer();
    },

    getMode() {
      return mode;
    },

    getServerInfoDisclosure() {
      return {
        telemetryMode: mode,
        telemetryEnabled: telemetryEnabled(),
        telemetryPublicDocUrl: publicDocUrl,
        showFreshInstallNotice: mode === 'minimal' && bootstrap?.kind === 'fresh_install',
      };
    },

    async recordSessionCreated(at) {
      if (!telemetryEnabled()) {
        return;
      }

      await store.recordSessionCreated(at);
    },

    async recordMessageSubmitted(at) {
      if (!telemetryEnabled()) {
        return;
      }

      await store.recordMessageSubmitted(at);
    },

    async recordToolCompleted(input) {
      if (!telemetryEnabled()) {
        return;
      }

      await store.recordToolCompleted(input);
    },

    async markFeatureUsed(feature, at) {
      if (!telemetryEnabled()) {
        return;
      }

      await store.markFeatureUsed(feature, at);
    },

    async reportError(input) {
      if (!telemetryEnabled() || !instanceId) {
        return;
      }

      try {
        const payload = buildErrorPayload({
          identity: { instanceId },
          appVersion: options.appVersion,
          installMethod,
          surface: resolveSurface(input.surface),
          error: input.error,
          errorCode: input.errorCode,
          occurredAt: input.occurredAt,
        });

        await transport.postJson('/v1/error', payload);
      } catch {
        return;
      }
    },
  };
}
