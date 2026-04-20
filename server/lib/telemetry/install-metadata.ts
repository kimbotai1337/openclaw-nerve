import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TelemetryMode = 'off' | 'minimal' | 'detailed';
export type InstallMethod = 'release' | 'source' | 'unknown';
export type MetadataSource = 'install.sh' | 'setup' | 'runtime';
export type BootstrapKind = 'fresh_install' | 'upgrade_legacy';

export interface IdentityRecord {
  instanceId: string;
  createdAt: string;
}

export interface InstallMethodStamp {
  installMethod: InstallMethod;
  stampedAt: string;
  source: MetadataSource;
}

export interface BootstrapMarker {
  kind: BootstrapKind;
  stampedAt: string;
  source: MetadataSource;
}

const IDENTITY_FILE = 'identity.json';
const INSTALL_METHOD_FILE = 'install-method.json';
const BOOTSTRAP_FILE = 'bootstrap.json';

function telemetryDir(): string {
  return process.env.NERVE_TELEMETRY_DIR || path.join(process.env.HOME || os.homedir(), '.nerve', 'telemetry');
}

function telemetryPath(fileName: string): string {
  return path.join(telemetryDir(), fileName);
}

function ensureTelemetryDir(): string {
  const dir = telemetryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJsonFile<T>(fileName: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(telemetryPath(fileName), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(fileName: string, value: unknown): void {
  ensureTelemetryDir();
  fs.writeFileSync(telemetryPath(fileName), JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function isInstallMethod(value: unknown): value is InstallMethod {
  return value === 'release' || value === 'source' || value === 'unknown';
}

function isMetadataSource(value: unknown): value is MetadataSource {
  return value === 'install.sh' || value === 'setup' || value === 'runtime';
}

function isBootstrapKind(value: unknown): value is BootstrapKind {
  return value === 'fresh_install' || value === 'upgrade_legacy';
}

function normalizeTelemetryMode(value: string | null | undefined): TelemetryMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized === 'off' || normalized === 'minimal' || normalized === 'detailed') {
    return normalized;
  }

  return undefined;
}

export function readIdentity(): IdentityRecord | undefined {
  const identity = readJsonFile<Partial<IdentityRecord>>(IDENTITY_FILE);
  if (!identity || typeof identity.instanceId !== 'string' || !identity.instanceId) {
    return undefined;
  }

  return {
    instanceId: identity.instanceId,
    createdAt: typeof identity.createdAt === 'string' && identity.createdAt
      ? identity.createdAt
      : new Date(0).toISOString(),
  };
}

export function writeIdentity(instanceId: string, createdAt = new Date().toISOString()): IdentityRecord {
  const record: IdentityRecord = { instanceId, createdAt };
  writeJsonFile(IDENTITY_FILE, record);
  return record;
}

export function ensureInstanceId(createdAt = new Date().toISOString()): string {
  const current = readIdentity();
  if (current?.instanceId) return current.instanceId;

  const instanceId = crypto.randomUUID();
  writeIdentity(instanceId, createdAt);
  return instanceId;
}

export function readInstallMethod(): InstallMethodStamp | undefined {
  const stamp = readJsonFile<Partial<InstallMethodStamp>>(INSTALL_METHOD_FILE);
  if (!stamp || !isInstallMethod(stamp.installMethod) || !isMetadataSource(stamp.source) || typeof stamp.stampedAt !== 'string' || !stamp.stampedAt) {
    return undefined;
  }

  return {
    installMethod: stamp.installMethod,
    stampedAt: stamp.stampedAt,
    source: stamp.source,
  };
}

export function writeInstallMethod(
  installMethod: InstallMethod,
  source: MetadataSource,
  stampedAt = new Date().toISOString(),
): InstallMethodStamp {
  const stamp: InstallMethodStamp = { installMethod, stampedAt, source };
  writeJsonFile(INSTALL_METHOD_FILE, stamp);
  return stamp;
}

export function readInstallMethodOrUnknown(stamp = readInstallMethod()): InstallMethod {
  return stamp?.installMethod || 'unknown';
}

export function resolveInstallMethodAfterSetup(
  current = readInstallMethod(),
  stampedAt = new Date().toISOString(),
): InstallMethodStamp {
  if (current?.installMethod === 'release' || current?.installMethod === 'source') {
    return current;
  }

  return {
    installMethod: 'source',
    stampedAt,
    source: 'setup',
  };
}

export function readBootstrapMarker(): BootstrapMarker | undefined {
  const marker = readJsonFile<Partial<BootstrapMarker>>(BOOTSTRAP_FILE);
  if (!marker || !isBootstrapKind(marker.kind) || !isMetadataSource(marker.source) || typeof marker.stampedAt !== 'string' || !marker.stampedAt) {
    return undefined;
  }

  return {
    kind: marker.kind,
    stampedAt: marker.stampedAt,
    source: marker.source,
  };
}

export function writeBootstrapMarker(
  kind: BootstrapKind,
  source: MetadataSource,
  stampedAt = new Date().toISOString(),
): BootstrapMarker {
  const marker: BootstrapMarker = { kind, stampedAt, source };
  writeJsonFile(BOOTSTRAP_FILE, marker);
  return marker;
}

export function isTrustedFreshInstallBootstrap(bootstrap: BootstrapMarker | undefined): boolean {
  return !!bootstrap
    && bootstrap.kind === 'fresh_install'
    && (bootstrap.source === 'install.sh' || bootstrap.source === 'setup');
}

export function resolveTelemetryMode(params: {
  envMode?: string | null;
  bootstrap?: BootstrapMarker;
}): TelemetryMode {
  const explicitMode = normalizeTelemetryMode(params.envMode);
  if (explicitMode) return explicitMode;

  return isTrustedFreshInstallBootstrap(params.bootstrap) ? 'minimal' : 'off';
}

export function ensureLegacyUpgradeMarker(params: {
  envMode?: string | null;
  stampedAt?: string;
} = {}): BootstrapMarker | undefined {
  const current = readBootstrapMarker();
  if (isTrustedFreshInstallBootstrap(current) || current?.kind === 'upgrade_legacy') {
    return current;
  }

  if (normalizeTelemetryMode(params.envMode)) {
    return current;
  }

  return writeBootstrapMarker('upgrade_legacy', 'runtime', params.stampedAt);
}
