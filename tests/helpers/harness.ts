import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuardConfigManager, type GuardConfigOverrides } from '../../src/core/guard-config.js';
import { ProcessMonitor, type RawProcessInfo } from '../../src/core/process-monitor.js';
import { WatchdogSession } from '../../src/core/session.js';

const created: string[] = [];

/** A fresh temp directory (real path, so it compares equal to what the monitor resolves). */
export function makeTmpDir(prefix = 'agent-leash-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of created.splice(0, created.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

export function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function initGitRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

export function commitAll(dir: string, message = 'init'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

export interface Harness {
  dir: string;
  configManager: GuardConfigManager;
  monitor: ProcessMonitor;
  session: WatchdogSession;
  /** Every signal the fake killer received, in order. */
  kills: Array<{ pid: number; signal: NodeJS.Signals | undefined }>;
  /** The fake process table. Mutate it to change what the next scan sees. */
  procs: RawProcessInfo[];
  /** PIDs that survive SIGTERM (only SIGKILL removes them). */
  stubborn: Set<number>;
}

export interface HarnessOptions {
  dir?: string;
  files?: Record<string, string | Buffer>;
  config?: GuardConfigOverrides;
  procs?: RawProcessInfo[];
  killGraceMs?: number;
}

/**
 * Monitor and session wired together like the CLI does it, but with a fake process table and a
 * fake killer. Nothing here can reach a real process.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? makeTmpDir();
  if (options.files) writeFiles(dir, options.files);

  const configManager = new GuardConfigManager(dir, options.config);
  const kills: Harness['kills'] = [];
  const procs: RawProcessInfo[] = [...(options.procs ?? [])];
  const stubborn = new Set<number>();

  const monitor = new ProcessMonitor({
    rootDir: dir,
    selfPid: 999_999,
    // front-end tests need a STALE row at once; the window itself is tested in process-control
    staleQuietSec: 0,
    killGraceMs: options.killGraceMs ?? 3000,
    processLister: async () => procs.map((p) => ({ ...p })),
    processKiller: (pid, signal) => {
      kills.push({ pid, signal });
      const index = procs.findIndex((p) => p.pid === pid);
      if (index === -1) return false;
      // pause and resume hold and continue a process; they never end it
      if (signal === 'SIGSTOP' || signal === 'SIGCONT') return true;
      if (signal === 'SIGKILL' || !stubborn.has(pid)) {
        procs.splice(index, 1);
      }
      return true;
    },
    processAlive: (pid) => procs.some((p) => p.pid === pid),
    // the table's RSS stands in for the footprint; RSS-only display is tested in process-control
    memoryReader: async (pids) =>
      new Map(procs.filter((p) => pids.includes(p.pid) && p.rssKb !== undefined).map((p) => [p.pid, p.rssKb! * 1024])),
  });

  const session = new WatchdogSession({ rootDir: dir, configManager, processMonitor: monitor });
  return { dir, configManager, monitor, session, kills, procs, stubborn };
}

/** Removes ANSI escape sequences so assertions can look at what a user would read. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[@-~]/g, '');
}
