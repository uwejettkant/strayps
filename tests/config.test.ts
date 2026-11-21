import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, DEFAULT_CONFIG, ConfigManager, legacyConfigNotice, writeConfigValue } from '../src/core/config.js';
import { cleanupTmpDirs, makeTmpDir, writeFiles } from './helpers/harness.js';

afterEach(cleanupTmpDirs);

function managerWith(config: unknown): ConfigManager {
  const dir = makeTmpDir();
  writeFiles(dir, { [CONFIG_FILENAME]: typeof config === 'string' ? config : JSON.stringify(config) });
  return new ConfigManager(dir);
}

describe('.strayps.json', () => {
  it('notices an .agentguard.json of agent-leash by its name alone', () => {
    const dir = makeTmpDir();
    expect(legacyConfigNotice(dir)).toBeNull();

    // a link to nowhere: only lstat can see it, so the notice proves the link was not followed
    fs.symlinkSync(path.join(dir, 'missing-target.json'), path.join(dir, '.agentguard.json'));
    expect(legacyConfigNotice(dir)).toBe(
      '.agentguard.json is from agent-leash; strayps does not read it: rename it to .strayps.json to keep its values.',
    );

    writeFiles(dir, { [CONFIG_FILENAME]: '{}' });
    expect(legacyConfigNotice(dir)).toContain('carry over what you still need with "strayps config set"');
  });

  it('loads a valid file without warnings', () => {
    const manager = managerWith({ agents: ['vibe', 'opencode'], limits: { mcpSilenceTimeoutSec: 120, staleSessionHours: 24 } });
    expect(manager.getWarnings()).toEqual([]);
    expect(manager.hasConfigFile()).toBe(true);
    expect(manager.getConfig()).toEqual({ agents: ['vibe', 'opencode'], limits: { mcpSilenceTimeoutSec: 120, staleSessionHours: 24 } });
  });

  it('fills in what a partial file leaves out', () => {
    const manager = managerWith({ limits: { staleSessionHours: 9 } });
    expect(manager.getWarnings()).toEqual([]);
    expect(manager.getConfig()).toEqual({ ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, staleSessionHours: 9 } });
  });

  it('says so when the file is broken instead of silently ignoring it', () => {
    for (const broken of ['{ this is not json', '[]', '"just a string"', 'null']) {
      const manager = managerWith(broken);
      expect(manager.getConfig(), broken).toEqual(DEFAULT_CONFIG);
      expect(manager.getWarnings(), broken).toHaveLength(1);
      expect(manager.getWarnings()[0]).toContain('using the defaults');
    }
  });

  it('refuses limits that are not whole numbers of at least 1', () => {
    const manager = managerWith({ limits: { staleSessionHours: -1, mcpSilenceTimeoutSec: null } });
    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG);
    const warnings = manager.getWarnings().join('\n');
    expect(warnings).toContain('limits.staleSessionHours must be a number >= 1 (got -1)');
    expect(warnings).toContain('limits.mcpSilenceTimeoutSec must be a number >= 1 (got null)');
  });

  it('still loads a file written for the file guard, and says which keys no longer apply', () => {
    const manager = managerWith({ protectedFiles: ['.env*'], agents: ['vibe'], limits: { maxFilesWarn: 15, staleSessionHours: 12 } });
    expect(manager.getConfig()).toEqual({ agents: ['vibe'], limits: { ...DEFAULT_CONFIG.limits, staleSessionHours: 12 } });
    const warnings = manager.getWarnings().join('\n');
    expect(warnings).toContain('"protectedFiles" no longer exists and is ignored');
    expect(warnings).toContain('limits.maxFilesWarn is not a known setting and is ignored');
  });

  it('rounds fractional limits down and keeps overrides above the file', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { staleSessionHours: 7.9, mcpSilenceTimeoutSec: 30 } }) });
    const manager = new ConfigManager(dir, { limits: { mcpSilenceTimeoutSec: 50 } });
    expect(manager.getConfig().limits.staleSessionHours).toBe(7);
    expect(manager.getConfig().limits.mcpSilenceTimeoutSec).toBe(50);
  });
});

describe('.strayps.json that is not a plain file', () => {
  it('reads nothing through a link: a link to .env leaks none of its contents', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.env': 'SECRET=from-env-123\n' });
    fs.symlinkSync('.env', path.join(dir, CONFIG_FILENAME));

    const manager = new ConfigManager(dir);
    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG);
    expect(manager.getWarnings().join(' ')).toContain('symbolic link');
    const reload = manager.reload();
    expect(reload.applied).toBe(false);
    expect(JSON.stringify([manager.getWarnings(), reload])).not.toContain('SECRET');

    expect(() => writeConfigValue(dir, 'limits.staleSessionHours', 5)).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('SECRET=from-env-123\n');
  });

  it('reports a link that points nowhere as there and refused, not as missing', () => {
    // config show said "No .strayps.json here" and, below it, that it is a symbolic link
    const dir = makeTmpDir();
    fs.symlinkSync('does-not-exist.json', path.join(dir, CONFIG_FILENAME));
    const manager = new ConfigManager(dir, undefined, { readOnly: true });
    expect(manager.hasConfigFile()).toBe(true);
    expect(manager.getWarnings().join(' ')).toContain('symbolic link');
    expect(new ConfigManager(makeTmpDir(), undefined, { readOnly: true }).hasConfigFile()).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reads and writes nothing through a hard link', () => {
    const outside = makeTmpDir('strayps-outside-');
    const dir = makeTmpDir();
    writeFiles(outside, { 'victim.json': '{"limits": {"staleSessionHours": 3}}' });
    fs.linkSync(path.join(outside, 'victim.json'), path.join(dir, CONFIG_FILENAME));

    const manager = new ConfigManager(dir);
    expect(manager.getConfig().limits.staleSessionHours).toBe(DEFAULT_CONFIG.limits.staleSessionHours);
    expect(manager.getWarnings().join(' ')).toContain('not a plain file');
    expect(() => writeConfigValue(dir, 'limits.staleSessionHours', 9)).toThrow(/not a plain file/);
    expect(fs.readFileSync(path.join(outside, 'victim.json'), 'utf-8')).toBe('{"limits": {"staleSessionHours": 3}}');
  });

  it('says where the JSON is broken without quoting the file', () => {
    // JSON.parse puts the start of the text into its error message
    const dir = makeTmpDir();
    writeFiles(dir, { [CONFIG_FILENAME]: 'TOKEN=abc123 {"limits": {}}' });
    const manager = new ConfigManager(dir);
    const warnings = manager.getWarnings().join(' ');
    expect(warnings).toContain('not valid JSON');
    expect(warnings).not.toContain('TOKEN');
    expect(JSON.stringify(manager.reload())).not.toContain('TOKEN');
    expect(() => writeConfigValue(dir, 'limits.staleSessionHours', 5)).toThrow(/not valid JSON/);
    try {
      writeConfigValue(dir, 'limits.staleSessionHours', 5);
    } catch (err) {
      expect(String(err)).not.toContain('TOKEN');
    }
  });
});
