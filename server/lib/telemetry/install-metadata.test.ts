// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let ensureInstanceId: typeof import('./install-metadata.js').ensureInstanceId;
let ensureLegacyUpgradeMarker: typeof import('./install-metadata.js').ensureLegacyUpgradeMarker;
let readBootstrapMarker: typeof import('./install-metadata.js').readBootstrapMarker;
let readInstallMethod: typeof import('./install-metadata.js').readInstallMethod;
let readInstallMethodOrUnknown: typeof import('./install-metadata.js').readInstallMethodOrUnknown;
let resolveInstallMethodAfterSetup: typeof import('./install-metadata.js').resolveInstallMethodAfterSetup;
let resolveTelemetryMode: typeof import('./install-metadata.js').resolveTelemetryMode;
let writeBootstrapMarker: typeof import('./install-metadata.js').writeBootstrapMarker;
let writeInstallMethod: typeof import('./install-metadata.js').writeInstallMethod;

describe('telemetry install metadata', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerve-telemetry-metadata-'));
    process.env = {
      ...originalEnv,
      NERVE_TELEMETRY_DIR: tempDir,
    };

    vi.resetModules();
    const mod = await import('./install-metadata.js');
    ensureInstanceId = mod.ensureInstanceId;
    ensureLegacyUpgradeMarker = mod.ensureLegacyUpgradeMarker;
    readBootstrapMarker = mod.readBootstrapMarker;
    readInstallMethod = mod.readInstallMethod;
    readInstallMethodOrUnknown = mod.readInstallMethodOrUnknown;
    resolveInstallMethodAfterSetup = mod.resolveInstallMethodAfterSetup;
    resolveTelemetryMode = mod.resolveTelemetryMode;
    writeBootstrapMarker = mod.writeBootstrapMarker;
    writeInstallMethod = mod.writeInstallMethod;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults a trusted fresh install to minimal when env mode is unset', () => {
    expect(resolveTelemetryMode({
      envMode: undefined,
      bootstrap: { kind: 'fresh_install', stampedAt: '2026-04-21T00:00:00Z', source: 'setup' },
    })).toBe('minimal');
  });

  it('treats a fresh release install marker the same way even when setup is skipped', () => {
    expect(resolveTelemetryMode({
      envMode: undefined,
      bootstrap: { kind: 'fresh_install', stampedAt: '2026-04-21T00:00:00Z', source: 'install.sh' },
    })).toBe('minimal');
  });

  it('keeps legacy upgrades off when env mode is unset', () => {
    expect(resolveTelemetryMode({
      envMode: undefined,
      bootstrap: { kind: 'upgrade_legacy', stampedAt: '2026-04-21T00:00:00Z', source: 'runtime' },
    })).toBe('off');
  });

  it('falls back to unknown install method when the stamp is missing', () => {
    expect(readInstallMethodOrUnknown(undefined)).toBe('unknown');
  });

  it('preserves an existing release stamp when setup runs later', () => {
    const current = { installMethod: 'release', stampedAt: '2026-04-21T00:00:00Z', source: 'install.sh' };
    expect(resolveInstallMethodAfterSetup(current)).toEqual(current);
  });

  it('persists a stable instance id once created', () => {
    const first = ensureInstanceId();
    const second = ensureInstanceId();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'identity.json'), 'utf8'));
    expect(stored.instanceId).toBe(first);
  });

  it('writes and reads install method stamps', () => {
    const written = writeInstallMethod('source', 'setup', '2026-04-21T00:00:00Z');

    expect(readInstallMethod()).toEqual(written);
  });

  it('writes and reads bootstrap markers', () => {
    const written = writeBootstrapMarker('fresh_install', 'setup', '2026-04-21T00:00:00Z');

    expect(readBootstrapMarker()).toEqual(written);
  });

  it('writes a legacy upgrade marker only when no trusted fresh-install marker exists', () => {
    const written = ensureLegacyUpgradeMarker({ envMode: undefined, stampedAt: '2026-04-21T00:00:00Z' });

    expect(written).toEqual({ kind: 'upgrade_legacy', stampedAt: '2026-04-21T00:00:00Z', source: 'runtime' });
    expect(readBootstrapMarker()).toEqual(written);
  });

  it('does not overwrite a trusted fresh-install marker when ensuring a legacy upgrade marker', () => {
    const current = writeBootstrapMarker('fresh_install', 'install.sh', '2026-04-21T00:00:00Z');

    const result = ensureLegacyUpgradeMarker({ envMode: undefined, stampedAt: '2026-04-22T00:00:00Z' });

    expect(result).toEqual(current);
    expect(readBootstrapMarker()).toEqual(current);
  });
});
