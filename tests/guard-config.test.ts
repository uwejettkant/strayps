import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  matchesGlobPattern,
  writeConfigValue,
} from '../src/core/guard-config.js';
import { cleanupTmpDirs, makeTmpDir, writeFiles } from './helpers/harness.js';

afterEach(cleanupTmpDirs);

function managerWith(config: unknown): GuardConfigManager {
  const dir = makeTmpDir();
  writeFiles(dir, { [CONFIG_FILENAME]: typeof config === 'string' ? config : JSON.stringify(config) });
  return new GuardConfigManager(dir);
}

describe('.agentguard.json', () => {
  it('loads a valid file without warnings', () => {
    const manager = managerWith({
      protectedFiles: ['secrets/**', 'prisma/schema.prisma'],
      agents: ['vibe', 'opencode'],
      limits: {
        maxFilesWarn: 5,
        maxFilesHardStop: 9,
        maxEditsPerFilePerMinute: 3,
        mcpSilenceTimeoutSec: 120,
        staleSessionHours: 24,
      },
    });
    expect(manager.getWarnings()).toEqual([]);
    expect(manager.hasConfigFile()).toBe(true);
    expect(manager.getConfig()).toEqual({
      protectedFiles: ['secrets/**', 'prisma/schema.prisma'],
      agents: ['vibe', 'opencode'],
      limits: {
        maxFilesWarn: 5,
        maxFilesHardStop: 9,
        maxEditsPerFilePerMinute: 3,
        mcpSilenceTimeoutSec: 120,
        staleSessionHours: 24,
      },
    });
  });

  it('fills in what a partial file leaves out', () => {
    const manager = managerWith({ limits: { maxEditsPerFilePerMinute: 9 } });
    expect(manager.getWarnings()).toEqual([]);
    expect(manager.getConfig()).toEqual({
      ...DEFAULT_GUARD_CONFIG,
      limits: { ...DEFAULT_GUARD_CONFIG.limits, maxEditsPerFilePerMinute: 9 },
    });
  });

  it('says so when the file is broken instead of silently ignoring it', () => {
    for (const broken of ['{ this is not json', '[]', '"just a string"', 'null']) {
      const manager = managerWith(broken);
      expect(manager.getConfig(), broken).toEqual(DEFAULT_GUARD_CONFIG);
      expect(manager.getWarnings(), broken).toHaveLength(1);
      expect(manager.getWarnings()[0]).toContain('using the defaults');
    }
  });

  it('refuses limits that would switch the guard off or make it fire on every edit', () => {
    const manager = managerWith({
      limits: { maxEditsPerFilePerMinute: -1, maxFilesWarn: 'many', maxFilesHardStop: 0, mcpSilenceTimeoutSec: null },
    });
    expect(manager.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    const warnings = manager.getWarnings().join('\n');
    expect(warnings).toContain('limits.maxEditsPerFilePerMinute must be a number >= 1 (got -1)');
    expect(warnings).toContain('limits.maxFilesWarn must be a number >= 1 (got "many")');
    expect(warnings).toContain('limits.maxFilesHardStop must be a number >= 1 (got 0)');
    expect(warnings).toContain('limits.mcpSilenceTimeoutSec must be a number >= 1 (got null)');
  });

  it('warns about impossible combinations and malformed lists', () => {
    const reversed = managerWith({ limits: { maxFilesWarn: 50, maxFilesHardStop: 10 } });
    expect(reversed.getWarnings().join('\n')).toContain('the warning will never show');

    const badList = managerWith({ protectedFiles: ['.env*', 7, '', null] });
    expect(badList.getConfig().protectedFiles).toEqual(['.env*']);
    expect(badList.getWarnings()).toHaveLength(1);

    const notAList = managerWith({ protectedFiles: '.env*', limits: [] });
    expect(notAList.getConfig().protectedFiles).toEqual(DEFAULT_GUARD_CONFIG.protectedFiles);
    expect(notAList.getWarnings()).toHaveLength(2);
  });

  it('rounds fractional limits down and keeps overrides above the file', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { [CONFIG_FILENAME]: JSON.stringify({ limits: { maxFilesWarn: 7.9, maxFilesHardStop: 30 } }) });
    const manager = new GuardConfigManager(dir, { limits: { maxFilesHardStop: 50 } });
    expect(manager.getConfig().limits.maxFilesWarn).toBe(7);
    expect(manager.getConfig().limits.maxFilesHardStop).toBe(50);
  });

});

describe('.agentguard.json that is not a plain file', () => {
  it('reads nothing through a link: a link to .env leaks none of its contents', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.env': 'SECRET=from-env-123\n' });
    fs.symlinkSync('.env', path.join(dir, CONFIG_FILENAME));

    const manager = new GuardConfigManager(dir);
    expect(manager.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    expect(manager.getWarnings().join(' ')).toContain('symbolic link');
    const reload = manager.reload();
    expect(reload.applied).toBe(false);
    expect(JSON.stringify([manager.getWarnings(), reload])).not.toContain('SECRET');

    expect(() => writeConfigValue(dir, 'limits.maxFilesWarn', 5)).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('SECRET=from-env-123\n');
  });

  it.skipIf(process.platform === 'win32')('reads and writes nothing through a hard link', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const dir = makeTmpDir();
    writeFiles(outside, { 'victim.json': '{"limits": {"maxFilesWarn": 3}}' });
    fs.linkSync(path.join(outside, 'victim.json'), path.join(dir, CONFIG_FILENAME));

    const manager = new GuardConfigManager(dir);
    expect(manager.getConfig().limits.maxFilesWarn).toBe(DEFAULT_GUARD_CONFIG.limits.maxFilesWarn);
    expect(manager.getWarnings().join(' ')).toContain('not a plain file');
    expect(() => writeConfigValue(dir, 'limits.maxFilesWarn', 9)).toThrow(/not a plain file/);
    expect(fs.readFileSync(path.join(outside, 'victim.json'), 'utf-8')).toBe('{"limits": {"maxFilesWarn": 3}}');
  });

  it('says where the JSON is broken without quoting the file', () => {
    // JSON.parse puts the start of the text into its error message
    const dir = makeTmpDir();
    writeFiles(dir, { [CONFIG_FILENAME]: 'TOKEN=abc123 {"limits": {}}' });
    const manager = new GuardConfigManager(dir);
    const warnings = manager.getWarnings().join(' ');
    expect(warnings).toContain('not valid JSON');
    expect(warnings).not.toContain('TOKEN');
    expect(JSON.stringify(manager.reload())).not.toContain('TOKEN');
    expect(() => writeConfigValue(dir, 'limits.maxFilesWarn', 5)).toThrow(/not valid JSON/);
    try {
      writeConfigValue(dir, 'limits.maxFilesWarn', 5);
    } catch (err) {
      expect(String(err)).not.toContain('TOKEN');
    }
  });
});

describe('protected file globs', () => {
  it('matches by path and, for patterns without a slash, by file name anywhere', () => {
    expect(matchesGlobPattern('.env', '.env*')).toBe(true);
    expect(matchesGlobPattern('apps/web/.env.local', '.env*')).toBe(true);
    expect(matchesGlobPattern('src/env.ts', '.env*')).toBe(false);
    expect(matchesGlobPattern('src/.environment/readme.md', '.env*')).toBe(false);
    expect(matchesGlobPattern('docker-compose.override.yml', 'docker-compose*.yml')).toBe(true);
    expect(matchesGlobPattern('docker-compose.yaml', 'docker-compose*.yml')).toBe(false);
    expect(matchesGlobPattern('secrets/prod/key.pem', 'secrets/**')).toBe(true);
    expect(matchesGlobPattern('src/secrets/key.pem', 'secrets/**')).toBe(false);
    expect(matchesGlobPattern('src/secrets/key.pem', '**/secrets/**')).toBe(true);
    expect(matchesGlobPattern('a/b/c.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlobPattern('c.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlobPattern('file1.txt', 'file?.txt')).toBe(true);
    expect(matchesGlobPattern('file10.txt', 'file?.txt')).toBe(false);
  });

  it('treats regular expression characters in patterns as literal text', () => {
    expect(matchesGlobPattern('a+b(c).ts', 'a+b(c).ts')).toBe(true);
    expect(matchesGlobPattern('aab(c)xts', 'a+b(c).ts')).toBe(false);
    expect(matchesGlobPattern('config[prod].json', 'config[prod].json')).toBe(true);
    expect(matchesGlobPattern('a.b', 'a?b')).toBe(true);
    expect(matchesGlobPattern('a/b', 'a?b')).toBe(false);
    // ** without a slash after it crosses directories, a single * does not
    expect(matchesGlobPattern('logs/2026/app.log', 'logs/**.log')).toBe(true);
    expect(matchesGlobPattern('logs/2026/app.log', 'logs/*.log')).toBe(false);
  });

  it('refuses patterns too long or too many to match on every file event', () => {
    const manager = managerWith({ protectedFiles: ['.env*', `${'a*'.repeat(300)}`, ...Array.from({ length: 300 }, (_, i) => `f${i}`)] });
    const { protectedFiles } = manager.getConfig();
    expect(protectedFiles).toHaveLength(256);
    expect(protectedFiles[0]).toBe('.env*');
    expect(protectedFiles.every((glob) => glob.length <= 512)).toBe(true);
    expect(manager.getWarnings().join(' ')).toMatch(/at most 512 characters.*more than 256 entries/);
  });

  it('matches hostile patterns from .agentguard.json without freezing the watchdog', () => {
    // The agent being watched can write .agentguard.json; nested wildcards made the old regular
    // expression backtrack for minutes on every file event
    const started = Date.now();
    expect(matchesGlobPattern('a'.repeat(200), `${'*a'.repeat(25)}b`)).toBe(false);
    expect(matchesGlobPattern(`${'x/'.repeat(100)}y`, `${'**/'.repeat(30)}z`)).toBe(false);
    expect(matchesGlobPattern(`${'x/'.repeat(100)}y`, `${'**/'.repeat(30)}y`)).toBe(true);
    expect(matchesGlobPattern(`${'ab/'.repeat(60)}d`, `${'**/a*'.repeat(20)}/c`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('resolves absolute paths against the repository root', () => {
    const dir = makeTmpDir();
    const manager = new GuardConfigManager(dir);
    expect(manager.isProtectedFile(path.join(dir, 'apps/api/.env.production'))).toBe(true);
    expect(manager.isProtectedFile(path.join(dir, 'apps/api/index.ts'))).toBe(false);
  });

  it('always applies every configured pattern: no setting turns protection off', () => {
    const manager = managerWith({ protectedFiles: ['.env*', 'docker-compose*.yml', 'infra/**'] });
    expect(manager.isProtectedFile('.env.local')).toBe(true);
    expect(manager.isProtectedFile('docker-compose.yml')).toBe(true);
    expect(manager.isProtectedFile('infra/main.tf')).toBe(true);
  });
});
