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
import type { WatchActivityEvent } from '../src/core/watcher.js';
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

describe('switching the mode at runtime', () => {
  it('writes only the mode and keeps everything else that is in the file, including edits made after start', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'balanced', limits: { maxFilesWarn: 15 }, custom: 'kept' });
    const manager = new GuardConfigManager(dir);

    // edited by hand while the watchdog runs (not reloaded yet)
    writeJson(dir, { mode: 'balanced', limits: { maxFilesWarn: 99 }, custom: 'kept' });

    expect(manager.switchMode('strict').persisted).toBe('written');
    expect(readJson(dir)).toEqual({ mode: 'strict', limits: { maxFilesWarn: 99 }, custom: 'kept' });
    expect(manager.getConfig().mode).toBe('strict');
  });

  it('never writes in read-only mode (demo)', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'balanced' });
    const before = sha(dir);
    const manager = new GuardConfigManager(dir, undefined, { readOnly: true });

    expect(manager.isReadOnly()).toBe(true);
    expect(manager.switchMode('yolo').persisted).toBe('read-only');
    expect(manager.getConfig().mode).toBe('yolo');
    expect(() => manager.saveConfig()).toThrow('read-only');
    expect(sha(dir)).toBe(before);
  });

  it('leaves a file alone that is not valid JSON, and creates none when there is none', () => {
    const half = makeTmpDir();
    writeJson(half, '{ "mode": "strict", ');
    const manager = new GuardConfigManager(half);
    expect(manager.switchMode('yolo').persisted).toBe('invalid-file');
    expect(fs.readFileSync(configPath(half), 'utf-8')).toBe('{ "mode": "strict", ');

    const none = makeTmpDir();
    expect(new GuardConfigManager(none).switchMode('strict').persisted).toBe('no-file');
    expect(fs.existsSync(configPath(none))).toBe(false);
  });
});

describe('reloading a changed file', () => {
  it('applies a valid change and says what changed', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { maxFilesWarn: 15 } });
    const manager = new GuardConfigManager(dir);

    writeJson(dir, { limits: { maxFilesWarn: 20, staleSessionHours: 24 }, protectedFiles: ['.env*', 'secrets/**'] });
    const result = manager.reload();

    expect(result.applied).toBe(true);
    expect(result.changes).toEqual([
      'limits.maxFilesWarn 15 → 20',
      'limits.staleSessionHours 6 → 24',
      'no longer protected: docker-compose*.yml, .git/**',
      'now protected: secrets/**',
    ]);
    expect(manager.getConfig().limits.maxFilesWarn).toBe(20);
    expect(manager.isProtectedFile('secrets/key.pem')).toBe(true);
    expect(manager.reload().changes).toEqual([]);

    writeJson(dir, { limits: { maxFilesWarn: 20, staleSessionHours: 24 }, protectedFiles: ['secrets/**', '.env*'] });
    expect(manager.reload().changes, 'the order of the globs does not matter').toEqual([]);
  });

  it('keeps the previous settings when the edit is not valid, and says why', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'strict', limits: { maxFilesWarn: 20 } });
    const manager = new GuardConfigManager(dir);
    const before = manager.getConfig();

    writeJson(dir, '{ "mode": "strict", "limits": { "maxFilesWarn": 2');
    const broken = manager.reload();
    expect(broken.applied).toBe(false);
    expect(broken.warnings[0]).toContain('not valid JSON');
    expect(manager.getConfig()).toEqual(before);

    // one bad value means nothing is applied, not even the good values next to it
    writeJson(dir, { mode: 'yolo', limits: { maxFilesWarn: 30, maxEditsPerFilePerMinute: 0 } });
    const invalid = manager.reload();
    expect(invalid.applied).toBe(false);
    expect(invalid.warnings).toEqual(['limits.maxEditsPerFilePerMinute must be a number >= 1 (got 0)']);
    expect(manager.getConfig()).toEqual(before);
  });

  it('applies the file but points out keys it does not know (typos)', () => {
    const dir = makeTmpDir();
    const manager = new GuardConfigManager(dir);
    writeJson(dir, { limits: { maxFileWarn: 3, maxFilesHardStop: 50 }, modes: 'strict' });

    const result = manager.reload();
    expect(result.applied).toBe(true);
    expect(result.changes).toEqual(['limits.maxFilesHardStop 40 → 50']);
    expect(result.warnings).toEqual([
      '"modes" is not a known setting and is ignored',
      'limits.maxFileWarn is not a known setting and is ignored',
    ]);
  });

  it('goes back to the defaults when the file is deleted', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'strict', limits: { maxFilesWarn: 3 } });
    const manager = new GuardConfigManager(dir);
    fs.rmSync(configPath(dir));

    const result = manager.reload();
    expect(result.applied).toBe(true);
    expect(manager.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    expect(result.changes).toContain('mode strict → balanced');
  });

  it('lets the most recent explicit choice of mode win', () => {
    const dir = makeTmpDir();
    writeJson(dir, { mode: 'balanced', limits: { maxFilesWarn: 15 } });
    // started with --mode yolo
    const manager = new GuardConfigManager(dir, { mode: 'yolo' });
    expect(manager.getConfig().mode).toBe('yolo');
    expect(manager.getSources().mode).toBe('override');

    // editing a limit does not undo the flag
    writeJson(dir, { mode: 'balanced', limits: { maxFilesWarn: 16 } });
    manager.reload();
    expect(manager.getConfig().mode).toBe('yolo');

    // editing the mode in the file does
    writeJson(dir, { mode: 'strict', limits: { maxFilesWarn: 16 } });
    manager.reload();
    expect(manager.getConfig().mode).toBe('strict');
    expect(manager.getSources().mode).toBe('file');

    // a switch in the terminal or dashboard is saved and survives the next edit of a limit
    manager.switchMode('balanced');
    expect(readJson(dir).mode).toBe('balanced');
    writeJson(dir, { ...readJson(dir), limits: { maxFilesWarn: 17 } });
    manager.reload();
    expect(manager.getConfig()).toMatchObject({ mode: 'balanced', limits: { maxFilesWarn: 17 } });
  });

  it('tells where every value comes from', () => {
    const dir = makeTmpDir();
    writeJson(dir, { limits: { maxFilesWarn: 20 } });
    const manager = new GuardConfigManager(dir, { limits: { maxEditsPerFilePerMinute: 3 } });

    const sources = manager.getSources();
    expect(Object.keys(sources).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(sources['limits.maxFilesWarn']).toBe('file');
    expect(sources['limits.maxEditsPerFilePerMinute']).toBe('override');
    expect(sources['limits.staleSessionHours']).toBe('default');
    expect(sources.mode).toBe('default');
    manager.switchMode('strict', false);
    expect(manager.getSources().mode).toBe('session');
  });
});

describe('changing single values (agent-leash config set / unset)', () => {
  it('knows every setting and describes it', () => {
    for (const key of CONFIG_KEYS) {
      expect(CONFIG_KEY_INFO[key].length).toBeGreaterThan(10);
    }
    expect(resolveConfigKey('limits.maxFilesWarn')).toBe('limits.maxFilesWarn');
    expect(resolveConfigKey('maxFilesWarn')).toBe('limits.maxFilesWarn');
    expect(resolveConfigKey('MAXFILESWARN')).toBe('limits.maxFilesWarn');
    expect(resolveConfigKey('staleSessionHours')).toBe('limits.staleSessionHours');
    expect(resolveConfigKey('Mode')).toBe('mode');
    expect(resolveConfigKey('protectedfiles')).toBe('protectedFiles');
    expect(resolveConfigKey('limits')).toBeNull();
    expect(resolveConfigKey('maxFileWarn')).toBeNull();
  });

  it('validates values the way the file is validated', () => {
    expect(parseConfigValue('mode', 'refactoring')).toEqual({ ok: true, value: 'yolo' });
    expect(parseConfigValue('mode', 'turbo')).toMatchObject({ ok: false });
    expect(parseConfigValue('limits.maxFilesWarn', '20')).toEqual({ ok: true, value: 20 });
    for (const bad of ['0', '-1', '1.5', 'many', '', '20 files']) {
      expect(parseConfigValue('limits.maxFilesWarn', bad), bad).toMatchObject({ ok: false });
    }
    expect(parseConfigValue('protectedFiles', '.env*, secrets/** ,,infra/*.tf')).toEqual({
      ok: true,
      value: ['.env*', 'secrets/**', 'infra/*.tf'],
    });
    expect(parseConfigValue('protectedFiles', ' , ')).toMatchObject({ ok: false });
  });

  it('creates a minimal file, changes one key at a time and keeps the rest', () => {
    const dir = makeTmpDir();
    const first = writeConfigValue(dir, 'limits.maxFilesWarn', 20);
    expect(first).toMatchObject({ created: true, changed: true, previous: undefined });
    expect(readJson(dir)).toEqual({ limits: { maxFilesWarn: 20 } });

    writeJson(dir, { ...readJson(dir), note: 'kept', limits: { maxFilesWarn: 20, maxFilesHardStop: 50 } });
    expect(writeConfigValue(dir, 'mode', 'strict')).toMatchObject({ created: false, previous: undefined });
    expect(writeConfigValue(dir, 'limits.maxFilesWarn', 25)).toMatchObject({ previous: 20 });
    expect(readJson(dir)).toEqual({ note: 'kept', limits: { maxFilesWarn: 25, maxFilesHardStop: 50 }, mode: 'strict' });

    expect(writeConfigValue(dir, 'limits.maxFilesWarn', undefined)).toMatchObject({ changed: true, previous: 25 });
    expect(writeConfigValue(dir, 'limits.maxFilesHardStop', undefined)).toMatchObject({ changed: true });
    expect(readJson(dir)).toEqual({ note: 'kept', mode: 'strict' });
    expect(writeConfigValue(dir, 'limits.staleSessionHours', undefined)).toMatchObject({ changed: false });
  });

  it('does not create a file just to remove something from it', () => {
    const dir = makeTmpDir();
    expect(writeConfigValue(dir, 'mode', undefined)).toMatchObject({ changed: false, created: false });
    expect(fs.existsSync(configPath(dir))).toBe(false);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    const dir = makeTmpDir();
    writeJson(dir, '{ "limits": ');
    expect(() => writeConfigValue(dir, 'mode', 'strict')).toThrow('Fix it first; nothing was changed');
    expect(fs.readFileSync(configPath(dir), 'utf-8')).toBe('{ "limits": ');
    writeJson(dir, '[1, 2]');
    expect(() => writeConfigValue(dir, 'mode', 'strict')).toThrow('must contain a JSON object');
  });
});

describe('a running session', () => {
  function configEvents(events: WatchActivityEvent[]) {
    return events.filter((e) => e.type === 'config-reload');
  }

  it('applies a changed file to the process monitor and the circuit breaker at once, and warns about it', () => {
    const h = createHarness();
    writeJson(h.dir, {
      limits: { maxEditsPerFilePerMinute: 3, mcpSilenceTimeoutSec: 90, staleSessionHours: 12, maxFilesWarn: 7 },
    });

    const result = h.session.reloadConfig();
    expect(result.applied).toBe(true);
    expect(h.monitor.getSilenceTimeoutSec()).toBe(90);
    expect(h.monitor.getStaleSessionHours()).toBe(12);
    expect(h.watcher.loopDetector.getMaxEditsPerFilePerMinute()).toBe(3);
    expect(h.session.getSnapshot().config.limits.maxFilesWarn).toBe(7);

    const [event] = configEvents(h.session.getSnapshot().events);
    // the agent being watched can write this file too: a reload must be visible with --quiet
    expect(event.severity).toBe('warn');
    expect(event.message).toContain('.agentguard.json reloaded:');
    expect(event.message).toContain('limits.maxEditsPerFilePerMinute 5 → 3');
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

    writeJson(h.dir, { limits: { maxFilesWarn: 9 } });
    h.session.reloadConfig();
    expect(h.session.getSnapshot().config.limits.maxFilesWarn).toBe(9);
  });

  it('says in the activity log whether a mode switch was saved', () => {
    const h = createHarness();
    h.session.setMode('strict');
    expect(h.session.getSnapshot().events[0].message).toBe(
      'Guard mode switched to STRICT for this session only (no .agentguard.json to save it in)',
    );
    expect(fs.existsSync(path.join(h.dir, CONFIG_FILENAME)), 'a mode switch never creates the file').toBe(false);

    writeJson(h.dir, { mode: 'balanced', limits: { maxFilesWarn: 15 } });
    h.configManager.loadFromDiskOrDefaults();
    writeJson(h.dir, { mode: 'balanced', limits: { maxFilesWarn: 99 } });

    h.session.setMode('strict');
    expect(readJson(h.dir)).toEqual({ mode: 'strict', limits: { maxFilesWarn: 99 } });
    expect(h.session.getSnapshot().events[0].message).toBe('Guard mode switched to STRICT (saved to .agentguard.json)');

    writeJson(h.dir, '{ "mode": ');
    h.session.setMode('yolo');
    const event = h.session.getSnapshot().events[0];
    expect(event.severity).toBe('warn');
    expect(event.message).toContain('for this session only: .agentguard.json is not valid JSON and was left untouched');
  });

  it('notices edits to the file by itself, and stops when told to', async () => {
    const h = createHarness();
    h.session.watchConfigFile(25);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFiles(h.dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { maxFilesWarn: 11 } }) });

      const started = Date.now();
      while (h.session.getSnapshot().config.limits.maxFilesWarn !== 11) {
        if (Date.now() - started > 4000) throw new Error('config change was not picked up');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      h.session.unwatchConfigFile();
    }

    writeFiles(h.dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { maxFilesWarn: 12 } }) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.session.getSnapshot().config.limits.maxFilesWarn).toBe(11);
  });
});
