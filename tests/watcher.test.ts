import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  matchesGlobPattern,
} from '../src/core/guard-config.js';
import { ProcessMonitor } from '../src/core/process-monitor.js';
import { RepoWatcher } from '../src/core/watcher.js';
import { createWatchdogApp } from '../src/server.js';

describe('GuardConfigManager & RepoWatcher', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-leash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses sensible defaults when .agentguard.json does not exist', () => {
    const manager = new GuardConfigManager(tmpDir);
    const cfg = manager.getConfig();

    expect(cfg).toEqual(DEFAULT_GUARD_CONFIG);
    expect(cfg.protectedFiles).toEqual(['.env*', 'docker-compose*.yml', '.git/**']);
    expect(cfg.limits.maxFilesWarn).toBe(15);
    expect(cfg.limits.maxFilesHardStop).toBe(40);
    expect(cfg.limits.maxEditsPerFilePerMinute).toBe(5);
    expect(cfg.limits.mcpSilenceTimeoutSec).toBe(45);
  });

  it('matches protected file globs (.env*, docker-compose*.yml, .git/**) accurately', () => {
    expect(matchesGlobPattern('.env', '.env*')).toBe(true);
    expect(matchesGlobPattern('.env.local', '.env*')).toBe(true);
    expect(matchesGlobPattern('packages/api/.env.production', '.env*')).toBe(true);
    expect(matchesGlobPattern('docker-compose.prod.yml', 'docker-compose*.yml')).toBe(true);
    expect(matchesGlobPattern('.git/config', '.git/**')).toBe(true);
    expect(matchesGlobPattern('src/env.ts', '.env*')).toBe(false);
  });

  it('warns at maxFilesWarn and raises the hard-stop alarm at maxFilesHardStop', () => {
    const manager = new GuardConfigManager(tmpDir);
    expect(manager.evaluateFileLimit(10)).toBe('ok');
    expect(manager.evaluateFileLimit(15)).toBe('warn');
    expect(manager.evaluateFileLimit(40)).toBe('hard-stop');
    expect(manager.isProtectedFile('docker-compose.yml')).toBe(true);
  });

  it('never reads or overwrites .env* files (warn-only), and raises an alarm for other protected files like docker-compose.yml', () => {
    const envPath = path.join(tmpDir, '.env');
    const composePath = path.join(tmpDir, 'docker-compose.yml');
    const codePath = path.join(tmpDir, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(codePath), { recursive: true });
    fs.writeFileSync(envPath, 'SECRET_KEY=initial-123\n', 'utf-8');
    fs.writeFileSync(composePath, 'version: "3.8"\n', 'utf-8');
    fs.writeFileSync(codePath, 'export const v = 1;\n', 'utf-8');

    const watcher = new RepoWatcher({ rootDir: tmpDir });
    const checkpoint = watcher.createCheckpoint();
    // Only docker-compose.yml and src/index.ts are snapshotted; .env is never read into memory
    expect(checkpoint.snapshottedFiles).toBe(2);

    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    // 1. Touching .env emits a warning event but NEVER reads or overwrites .env
    fs.writeFileSync(envPath, 'SECRET_KEY=updated-by-user-or-agent\n', 'utf-8');
    watcher.handleFileSystemEvent('change', envPath);

    expect(onProtected).toHaveBeenCalledTimes(1);
    expect(onProtected.mock.calls[0][0].rolledBack).not.toBe(true);
    expect(onProtected.mock.calls[0][0].severity).toBe('warn');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('SECRET_KEY=updated-by-user-or-agent\n');

    // 2. Touching docker-compose.yml raises a critical alarm; only a revert restores it
    fs.writeFileSync(composePath, 'version: "corrupted"\n', 'utf-8');
    watcher.handleFileSystemEvent('change', composePath);

    expect(onProtected).toHaveBeenCalledTimes(2);
    expect(onProtected.mock.calls[1][0].severity).toBe('critical');
    expect(fs.readFileSync(composePath, 'utf-8')).toBe('version: "corrupted"\n');
    expect(watcher.rollbackFile('docker-compose.yml')).toBe(true);
    expect(fs.readFileSync(composePath, 'utf-8')).toBe('version: "3.8"\n');
  });

  it('triggers the circuit breaker on file thrashing, and revert restores the version before the series', () => {
    const targetFile = path.join(tmpDir, 'src', 'thrash.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, 'export const stable = true;\n', 'utf-8');

    const configManager = new GuardConfigManager(tmpDir, {
      limits: {
        maxFilesWarn: 15,
        maxFilesHardStop: 40,
        maxEditsPerFilePerMinute: 3,
        mcpSilenceTimeoutSec: 45,
      },
    });

    const watcher = new RepoWatcher({
      rootDir: tmpDir,
      configManager,
    });
    watcher.createCheckpoint();

    const onLoop = vi.fn();
    watcher.on('loop-detected', onLoop);

    const baseTime = 50_000;
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(targetFile, `export const stable = ${i};\n`, 'utf-8');
      watcher.handleFileSystemEvent('change', targetFile, baseTime + i * 100);
    }
    expect(onLoop).not.toHaveBeenCalled();

    // 4th edit in under 60 seconds exceeds maxEditsPerFilePerMinute (3)
    fs.writeFileSync(targetFile, 'export const stable = "corrupted-loop";\n', 'utf-8');
    watcher.handleFileSystemEvent('change', targetFile, baseTime + 500);

    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe('export const stable = "corrupted-loop";\n');
    expect(watcher.rollbackFile('src/thrash.ts')).toBe(true);
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe('export const stable = true;\n');
  });

  it('restores modified and newly added files one at a time through the API', async () => {
    const fileA = path.join(tmpDir, 'a.ts');
    const fileB = path.join(tmpDir, 'new-agent-file.ts');
    fs.writeFileSync(fileA, 'const a = 1;\n', 'utf-8');

    const configManager = new GuardConfigManager(tmpDir);
    const watcher = new RepoWatcher({ rootDir: tmpDir, configManager });
    watcher.createCheckpoint();

    const processMonitor = new ProcessMonitor({
      rootDir: tmpDir,
      processLister: async () => [],
    });

    const { app, token } = createWatchdogApp({
      rootDir: tmpDir,
      configManager,
      watcher,
      processMonitor,
    });

    // Agent modifies fileA and creates fileB
    fs.writeFileSync(fileA, 'const a = 999;\n', 'utf-8');
    watcher.handleFileSystemEvent('change', fileA);
    fs.writeFileSync(fileB, 'const rogue = true;\n', 'utf-8');
    watcher.handleFileSystemEvent('add', fileB);

    const statusRes = await app.request('/api/status');
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { modifiedFiles: string[] };
    expect(statusJson.modifiedFiles).toContain('a.ts');
    expect(statusJson.modifiedFiles).toContain('new-agent-file.ts');

    for (const filePath of ['a.ts', 'new-agent-file.ts']) {
      const res = await app.request('/api/rollback-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-leash-token': token },
        body: JSON.stringify({ filePath }),
      });
      expect(((await res.json()) as { ok: boolean }).ok, filePath).toBe(true);
    }
    expect(fs.readFileSync(fileA, 'utf-8')).toBe('const a = 1;\n');
    expect(fs.existsSync(fileB)).toBe(false);

    // Verify Dashboard UI endpoint serves dark-mode single-page app
    const uiRes = await app.request('/');
    expect(uiRes.status).toBe(200);
    const html = await uiRes.text();
    expect(html).toContain('id="pause-btn"');
    expect(html).toContain('id="confirm-dialog"');
    expect(html).toContain('name="color-scheme" content="light dark"');
  });

  it('creates a git checkpoint in a real git repository and watches live chokidar file events', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'ignore' });

    const trackedFile = path.join(tmpDir, 'tracked.ts');
    fs.writeFileSync(trackedFile, 'export const v = "initial";\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    const watcher = new RepoWatcher({ rootDir: tmpDir });
    const checkpoint = await watcher.start();

    try {
      expect(['git-head', 'git-stash-commit']).toContain(checkpoint.type);

      const editPromise = new Promise<void>((resolve) => {
        watcher.once('file-edit', (ev) => {
          if (ev.filePath === 'tracked.ts') {
            resolve();
          }
        });
      });

      // Brief delay so macOS FSEvents settles after git commit before modifying the tracked file
      await new Promise((r) => setTimeout(r, 80));
      fs.writeFileSync(trackedFile, 'export const v = "modified";\n', 'utf-8');
      await editPromise;

      expect(watcher.getModifiedFiles()).toContain('tracked.ts');
      watcher.rollbackFile('tracked.ts');
      expect(fs.readFileSync(trackedFile, 'utf-8')).toBe('export const v = "initial";\n');
    } finally {
      await watcher.stop();
    }
  });
});
