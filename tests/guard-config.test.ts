import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  globToRegExp,
  matchesGlobPattern,
  normalizeMode,
  parseMode,
} from '../src/core/guard-config.js';
import { cleanupTmpDirs, makeTmpDir, writeFiles } from './helpers/harness.js';

afterEach(cleanupTmpDirs);

function managerWith(config: unknown): GuardConfigManager {
  const dir = makeTmpDir();
  writeFiles(dir, { [CONFIG_FILENAME]: typeof config === 'string' ? config : JSON.stringify(config) });
  return new GuardConfigManager(dir);
}

describe('guard modes', () => {
  it('parses user input strictly and config values leniently', () => {
    expect(parseMode('strict')).toBe('strict');
    expect(parseMode(' Balanced ')).toBe('balanced');
    expect(parseMode('YOLO')).toBe('yolo');
    expect(parseMode('refactoring')).toBe('yolo');
    for (const bad of ['stricct', '', 'strict mode', 1, null, undefined, {}]) {
      expect(parseMode(bad), String(bad)).toBeNull();
    }
    expect(normalizeMode('stricct')).toBe('balanced');
    expect(normalizeMode(undefined)).toBe('balanced');
  });
});

describe('.agentguard.json', () => {
  it('loads a valid file without warnings', () => {
    const manager = managerWith({
      mode: 'strict',
      protectedFiles: ['secrets/**', 'prisma/schema.prisma'],
      limits: { maxFilesWarn: 5, maxFilesHardStop: 9, maxEditsPerFilePerMinute: 3, mcpSilenceTimeoutSec: 120 },
    });
    expect(manager.getWarnings()).toEqual([]);
    expect(manager.hasConfigFile()).toBe(true);
    expect(manager.getConfig()).toEqual({
      mode: 'strict',
      protectedFiles: ['secrets/**', 'prisma/schema.prisma'],
      limits: { maxFilesWarn: 5, maxFilesHardStop: 9, maxEditsPerFilePerMinute: 3, mcpSilenceTimeoutSec: 120 },
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
      mode: 'turbo',
      limits: { maxEditsPerFilePerMinute: -1, maxFilesWarn: 'many', maxFilesHardStop: 0, mcpSilenceTimeoutSec: null },
    });
    expect(manager.getConfig()).toEqual(DEFAULT_GUARD_CONFIG);
    const warnings = manager.getWarnings().join('\n');
    expect(warnings).toContain('mode "turbo"');
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
    writeFiles(dir, { [CONFIG_FILENAME]: JSON.stringify({ mode: 'strict', limits: { maxFilesWarn: 7.9 } }) });
    const manager = new GuardConfigManager(dir, { mode: 'yolo' });
    expect(manager.getConfig().mode).toBe('yolo');
    expect(manager.getConfig().limits.maxFilesWarn).toBe(7);
  });

  it('writes a mode change back only if a config file already exists', () => {
    const without = new GuardConfigManager(makeTmpDir());
    without.setMode('strict', true);
    expect(without.hasConfigFile()).toBe(false);

    const withFile = managerWith({ mode: 'balanced' });
    withFile.setMode('strict', true);
    const onDisk = JSON.parse(fs.readFileSync(withFile.configFilePath, 'utf-8')) as { mode: string };
    expect(onDisk.mode).toBe('strict');
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
    expect(globToRegExp('a+b(c).ts').test('a+b(c).ts')).toBe(true);
    expect(globToRegExp('a+b(c).ts').test('aab(c)xts')).toBe(false);
    expect(matchesGlobPattern('config[prod].json', 'config[prod].json')).toBe(true);
  });

  it('resolves absolute paths against the repository root', () => {
    const dir = makeTmpDir();
    const manager = new GuardConfigManager(dir);
    expect(manager.isProtectedFile(path.join(dir, 'apps/api/.env.production'))).toBe(true);
    expect(manager.isProtectedFile(path.join(dir, 'apps/api/index.ts'))).toBe(false);
  });

  it('keeps secrets protected in yolo mode but drops the other patterns', () => {
    const manager = managerWith({ mode: 'yolo', protectedFiles: ['.env*', 'docker-compose*.yml', 'infra/**'] });
    expect(manager.isProtectedFile('.env.local')).toBe(true);
    expect(manager.isProtectedFile('docker-compose.yml')).toBe(false);
    expect(manager.isProtectedFile('infra/main.tf')).toBe(false);
  });
});
