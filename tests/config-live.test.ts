import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  CONFIG_KEY_INFO,
  CONFIG_KEYS,
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  parseConfigValue,
  resolveConfigKey,
  writeConfigValue,
} from '../src/core/guard-config.js';
import type { ActivityEvent } from '../src/core/events.js';
import { cleanupTmpDirs, createHarness, makeTmpDir, writeFiles } from './helpers/harness.js';

afterEach(cleanupTmpDirs);

function configPath(dir: string): string {
  return path.join(dir, CONFIG_FILENAME);
}

function readJson(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath(dir), 'utf-8')) as Record<string, any>;
}

function writeJson(dir: string, value: unknown): void {
  fs.writeFileSync(configPath(dir), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function sha(dir: string): string {
  return createHash('sha256').update(fs.readFileSync(configPath(dir))).digest('hex');
}

describe('old files', () => {
  it('still loads an old file with "mode", ignores the key and says so', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'yolo', limits: { staleSessionHours: 20 } });
    const manager = new GuardConfigManager(dir);

    expect(manager.getConfig()).toEqual({ ...DEFAULT_GUARD_CONFIG, limits: { ...DEFAULT_GUARD_CONFIG.limits, staleSessionHours: 20 } });
    expect(manager.getWarnings()).toEqual([
      '"mode" no longer exists and is ignored: agent-leash always watches by the settings in this file',
    ]);
  });

  it('never writes in read-only mode (demo)', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { staleSessionHours: 20 } });
    const before = sha(dir);
    const manager = new GuardConfigManager(dir, undefined, { readOnly: true });

    expect(manager.isReadOnly()).toBe(true);
    expect(() => manager.saveConfig()).toThrow('read-only');
    expect(sha(dir)).toBe(before);
  });
});

describe('reloading a changed file', () => {
  it('applies a valid change and says what changed', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { staleSessionHours: 6 } });
    const manager = new GuardConfigManager(dir);

    writeJson(dir, { limits: { staleSessionHours: 24, mcpSilenceTimeoutSec: 90 }, agents: ['vibe'] });
    const result = manager.reload();

    expect(result.applied).toBe(true);
    expect(result.changes).toEqual(['limits.mcpSilenceTimeoutSec 45 → 90', 'limits.staleSessionHours 6 → 24', 'now treated as agents: vibe']);
    expect(manager.getConfig().limits.staleSessionHours).toBe(24);
    expect(manager.reload().changes).toEqual([]);
  });

  it('keeps the previous settings when the edit is not valid, and says why', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { staleSessionHours: 20 } });
    const manager = new GuardConfigManager(dir);
    const before = manager.getConfig();

    writeJson(dir, '{ "limits": { "staleSessionHours": 2');
    const broken = manager.reload();
    expect(broken.applied).toBe(false);
    expect(broken.warnings[0]).toContain('not valid JSON');
    expect(manager.getConfig()).toEqual(before);

    // one bad value means nothing is applied, not even the good values next to it
    writeJson(dir, { limits: { staleSessionHours: 30, mcpSilenceTimeoutSec: 0 } });
    const invalid = manager.reload();
    expect(invalid.applied).toBe(false);
    expect(invalid.warnings).toEqual(['limits.mcpSilenceTimeoutSec must be a number >= 1 (got 0)']);
    expect(manager.getConfig()).toEqual(before);
  });

  it('applies the file but points out keys it does not know (typos)', () => {
    const dir = makeTmpDir();
    const manager = new GuardConfigManager(dir);
    writeJson(dir, { limits: { staleSessionHour: 3, mcpSilenceTimeoutSec: 50 }, modes: 'strict' });

    const result = manager.reload();
    expect(result.applied).toBe(true);
    expect(result.changes).toEqual(['limits.mcpSilenceTimeoutSec 45 → 50']);
    expect(result.warnings).toEqual([
      '"modes" is not a known setting and is ignored',
      'limits.staleSessionHour is not a known setting and is ignored',
    ]);
  });

  it('goes back to the defaults when the file is deleted', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { staleSessionHours: 3 } });
    const manager = new GuardConfigManager(dir);
    fs.rmSync(configPath(dir));

    const result = manager.reload();
    expect(result.applied).toBe(true);
    expect(manager.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    expect(result.changes).toContain('limits.staleSessionHours 3 → 6');
  });

  it('tells where every value comes from', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { staleSessionHours: 20 } });
    const manager = new GuardConfigManager(dir, { limits: { mcpSilenceTimeoutSec: 30 } });

    const sources = manager.getSources();
    expect(Object.keys(sources).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(sources['limits.staleSessionHours']).toBe('file');
    expect(sources['limits.mcpSilenceTimeoutSec']).toBe('override');
    expect(sources.agents).toBe('default');
  });
});

describe('changing single values (agent-leash config set / unset)', () => {
  it('knows every setting and describes it', () => {
    for (const key of CONFIG_KEYS) {
      expect(CONFIG_KEY_INFO[key].length).toBeGreaterThan(10);
    }
    expect(resolveConfigKey('limits.staleSessionHours')).toBe('limits.staleSessionHours');
    expect(resolveConfigKey('staleSessionHours')).toBe('limits.staleSessionHours');
    expect(resolveConfigKey('STALESESSIONHOURS')).toBe('limits.staleSessionHours');
    expect(resolveConfigKey('Mode')).toBeNull();
    expect(resolveConfigKey('protectedFiles')).toBeNull();
    expect(resolveConfigKey('maxFilesWarn')).toBeNull();
    expect(resolveConfigKey('limits')).toBeNull();
  });

  it('validates values the way the file is validated', () => {
    expect(parseConfigValue('limits.staleSessionHours', '20')).toEqual({ ok: true, value: 20 });
    for (const bad of ['0', '-1', '1.5', 'many', '', '20 hours']) {
      expect(parseConfigValue('limits.staleSessionHours', bad), bad).toMatchObject({ ok: false });
    }
    expect(parseConfigValue('agents', 'vibe, opencode')).toEqual({ ok: true, value: ['vibe', 'opencode'] });
    for (const bad of ['', ' , ', 'my agent', '/usr/local/bin/vibe']) {
      expect(parseConfigValue('agents', bad), bad).toMatchObject({ ok: false });
    }
  });

  it('reads agent names from the file and refuses anything that is not a program name', () => {
    const dir = makeTmpDir();
    writeJson(dir, { agents: ['vibe', 'my agent', 42, '/bin/opencode'] });
    const manager = new GuardConfigManager(dir);
    expect(manager.getConfig().agents).toEqual(['vibe']);
    expect(manager.getWarnings()).toEqual([
      'agents contains entries that are not program names (a name like "vibe", no path, no spaces), they were ignored',
    ]);

    writeJson(dir, { agents: 'vibe' });
    expect(manager.reload()).toMatchObject({ applied: false, warnings: ['agents must be an array of program names'] });
    expect(manager.getConfig().agents).toEqual(['vibe']);
  });

  it('creates a minimal file, changes one key at a time and keeps the rest', () => {
    const dir = makeTmpDir();
    const first = writeConfigValue(dir, 'limits.staleSessionHours', 20);
    expect(first).toMatchObject({ created: true, changed: true, previous: undefined });
    expect(readJson(dir)).toEqual({ limits: { staleSessionHours: 20 } });

    writeJson(dir, { ...readJson(dir), note: 'kept', limits: { staleSessionHours: 20, mcpSilenceTimeoutSec: 50 } });
    expect(writeConfigValue(dir, 'agents', ['vibe'])).toMatchObject({ created: false, previous: undefined });
    expect(writeConfigValue(dir, 'limits.staleSessionHours', 25)).toMatchObject({ previous: 20 });
    expect(readJson(dir)).toEqual({ note: 'kept', limits: { staleSessionHours: 25, mcpSilenceTimeoutSec: 50 }, agents: ['vibe'] });

    expect(writeConfigValue(dir, 'limits.staleSessionHours', undefined)).toMatchObject({ changed: true, previous: 25 });
    expect(writeConfigValue(dir, 'limits.mcpSilenceTimeoutSec', undefined)).toMatchObject({ changed: true });
    expect(readJson(dir)).toEqual({ note: 'kept', agents: ['vibe'] });
    expect(writeConfigValue(dir, 'limits.staleSessionHours', undefined)).toMatchObject({ changed: false });
  });

  it('does not create a file just to remove something from it', () => {
    const dir = makeTmpDir();
    expect(writeConfigValue(dir, 'agents', undefined)).toMatchObject({ changed: false, created: false });
    expect(fs.existsSync(configPath(dir))).toBe(false);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    const dir = makeTmpDir();
    writeJson(dir, '{ "limits": ');
    expect(() => writeConfigValue(dir, 'agents', ['vibe'])).toThrow('Fix it first; nothing was changed');
    expect(fs.readFileSync(configPath(dir), 'utf-8')).toBe('{ "limits": ');
    writeJson(dir, '[1, 2]');
    expect(() => writeConfigValue(dir, 'agents', ['vibe'])).toThrow('must contain a JSON object');
  });
});

describe('a running session', () => {
  function configEvents(events: ActivityEvent[]) {
    return events.filter((e) => e.type === 'config-reload');
  }

  it('applies a changed file to the process monitor at once, and warns about it', () => {
    const h = createHarness();
    writeJson(h.dir, { limits: { mcpSilenceTimeoutSec: 90, staleSessionHours: 12 } });

    const result = h.session.reloadConfig();
    expect(result.applied).toBe(true);
    expect(h.monitor.getAgentNames()).toEqual([]);
    expect(h.monitor.getSilenceTimeoutSec()).toBe(90);
    expect(h.monitor.getStaleSessionHours()).toBe(12);

    const [event] = configEvents(h.session.getSnapshot().events);
    // the agent being watched can write this file too: a reload must be visible with --quiet
    expect(event.severity).toBe('warn');
    expect(event.message).toContain('.agentguard.json reloaded:');
    expect(event.message).toContain('limits.staleSessionHours 6 → 12');

    writeJson(h.dir, { agents: ['vibe'] });
    expect(h.session.reloadConfig().changes).toContain('now treated as agents: vibe');
    expect(h.monitor.getAgentNames()).toEqual(['vibe']);
  });

  it('reports a file it cannot apply once, and keeps going with the previous settings', () => {
    const h = createHarness();
    writeJson(h.dir, '{ broken');
    h.session.reloadConfig();
    h.session.reloadConfig();

    const events = configEvents(h.session.getSnapshot().events);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('warn');
    expect(events[0].message).toContain('was not applied, previous settings kept');
    expect(h.session.getSnapshot().config).toEqual(DEFAULT_GUARD_CONFIG);

    writeJson(h.dir, { limits: { staleSessionHours: 9 } });
    h.session.reloadConfig();
    expect(h.session.getSnapshot().config.limits.staleSessionHours).toBe(9);
  });

  it('notices edits to the file by itself, and stops when told to', async () => {
    const h = createHarness();
    h.session.watchConfigFile(25);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFiles(h.dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { staleSessionHours: 11 } }) });

      const started = Date.now();
      while (h.session.getSnapshot().config.limits.staleSessionHours !== 11) {
        if (Date.now() - started > 4000) throw new Error('config change was not picked up');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      h.session.unwatchConfigFile();
    }

    writeFiles(h.dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { staleSessionHours: 12 } }) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.session.getSnapshot().config.limits.staleSessionHours).toBe(11);
  });
});
