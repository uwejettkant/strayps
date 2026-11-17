import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { CONFIG_FILENAME, GuardConfigManager } from './guard-config.js';
import { type LoopAlert, LoopDetector } from './loop-detector.js';

export type WatchEventType =
  | 'file-edit'
  | 'protected-file'
  | 'loop-detected'
  | 'limit-warn'
  | 'limit-hard-stop'
  | 'rollback'
  | 'rollback-failed'
  | 'panic-rollback'
  | 'checkpoint-created'
  | 'watch-error'
  | 'mode-change'
  | 'config-reload'
  | 'process-alert'
  | 'process-recovered'
  | 'process-killed';

export interface WatchActivityEvent {
  id: string;
  type: WatchEventType;
  filePath?: string;
  action?: 'add' | 'change' | 'unlink';
  message: string;
  severity: 'info' | 'warn' | 'critical';
  timestamp: number;
  editCount?: number;
  modifiedFilesCount?: number;
  rolledBack?: boolean;
}

export interface CheckpointInfo {
  type: 'git-stash-commit' | 'git-head' | 'memory-snapshot';
  ref: string;
  createdAt: number;
  snapshottedFiles: number;
}

export interface RepoWatcherOptions {
  rootDir: string;
  configManager?: GuardConfigManager;
  loopDetector?: LoopDetector;
  autoRollbackOnLoop?: boolean;
  autoRollbackProtected?: boolean;
  debounceMs?: number;
  /**
   * Simulation mode (used by `--demo`): nothing is read from or written to disk.
   * No snapshot, no git calls, no file watcher; rollbacks are only reported.
   */
  dryRun?: boolean;
  /**
   * Keep a copy of every file version a rollback overwrites or deletes in a private
   * temp directory (default: true), so that a rollback never destroys work for good.
   */
  keepDiscarded?: boolean;
}

export interface PanicRollbackResult {
  restoredFiles: string[];
  count: number;
  /** Files that could not be restored because no checkpoint copy exists. */
  skippedFiles: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  'playwright-report',
  'test-results',
]);

/** Relative paths use forward slashes everywhere. A backslash is only a separator on Windows. */
function toPosixPath(value: string): string {
  return path.sep === '\\' ? value.replace(/\\/g, '/') : value;
}

/** Files up to this size are held in memory for exact restoration. */
const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * After a rollback writes or removes a file, file system events for that path are
 * treated as our own echo for this long, as long as the file still has the state we left it in.
 */
const OWN_WRITE_WINDOW_MS = 2000;

interface OwnWrite {
  /** Content we wrote, or null when we removed the file. */
  expected: Buffer | null;
  until: number;
}

interface RestoreOutcome {
  ok: boolean;
  action?: 'restored' | 'removed' | 'unchanged' | 'simulated';
  reason?: string;
  backupPath?: string;
}

/** Larger files are restored without keeping the replaced version (they are not in the snapshot either). */
const DISCARD_MAX_BYTES = 50 * 1024 * 1024;
/** Upper bound of replaced versions kept per session; the oldest are dropped first. */
const DISCARD_MAX_COPIES = 300;

export class RepoWatcher extends EventEmitter {
  public readonly rootDir: string;
  public readonly configManager: GuardConfigManager;
  public readonly loopDetector: LoopDetector;
  public readonly dryRun: boolean;

  private watcher: FSWatcher | null = null;
  private autoRollbackOnLoop: boolean;
  private autoRollbackProtected: boolean;
  private keepDiscarded: boolean;
  private initialSnapshot: Map<string, Buffer> = new Map();
  /** Every path that existed at session start, including files we hold no copy of. */
  private existedAtStart: Set<string> = new Set();
  private modifiedFiles: Set<string> = new Set();
  private ownWrites: Map<string, OwnWrite> = new Map();
  private checkpoint: CheckpointInfo | null = null;
  private checkpointSha: string | null = null;
  private recentEvents: WatchActivityEvent[] = [];
  private isGitRepo: boolean = false;
  private lastLimitState: 'ok' | 'warn' | 'hard-stop' = 'ok';
  private discardDir: string | null = null;
  private discardCounter = 0;
  private discardSlots: string[] = [];
  private rootCheckTimer: NodeJS.Timeout | null = null;
  private rootMissingReported = false;

  constructor(options: RepoWatcherOptions) {
    super();
    try {
      this.rootDir = fs.realpathSync(path.resolve(options.rootDir));
    } catch {
      this.rootDir = path.resolve(options.rootDir);
    }
    this.configManager = options.configManager ?? new GuardConfigManager(this.rootDir);
    const cfg = this.configManager.getConfig();
    this.loopDetector =
      options.loopDetector ??
      new LoopDetector({
        maxEditsPerFilePerMinute: cfg.limits.maxEditsPerFilePerMinute,
      });
    this.autoRollbackOnLoop = options.autoRollbackOnLoop ?? true;
    this.autoRollbackProtected = options.autoRollbackProtected ?? true;
    this.dryRun = options.dryRun ?? false;
    this.keepDiscarded = options.keepDiscarded ?? true;
  }

  public getCheckpoint(): CheckpointInfo | null {
    return this.checkpoint;
  }

  public getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }

  public getRecentEvents(limit: number = 100): WatchActivityEvent[] {
    return this.recentEvents.slice(0, limit);
  }

  public getLimitState(): 'ok' | 'warn' | 'hard-stop' {
    return this.lastLimitState;
  }

  /** Directory holding the file versions that rollbacks replaced, or null if none were kept yet. */
  public getDiscardDir(): string | null {
    return this.discardDir;
  }

  /**
   * Starts the file watcher and creates an initial Git / file-diff snapshot checkpoint.
   */
  public async start(): Promise<CheckpointInfo> {
    if (this.watcher) {
      return this.checkpoint!;
    }

    const checkpoint = this.createCheckpoint();

    if (this.dryRun) {
      return checkpoint;
    }

    this.watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: true,
      persistent: true,
      ignored: (targetPath: string) => this.shouldIgnorePath(targetPath),
      awaitWriteFinish: false,
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.watcher) return resolve();
      const onReady = () => {
        this.watcher?.off('error', onError);
        resolve();
      };
      const onError = (err: unknown) => {
        this.watcher?.off('ready', onReady);
        reject(err);
      };
      this.watcher.once('ready', onReady);
      this.watcher.once('error', onError);
    });

    this.watcher.on('add', (fullPath) => this.handleFileSystemEvent('add', fullPath));
    this.watcher.on('change', (fullPath) => this.handleFileSystemEvent('change', fullPath));
    this.watcher.on('unlink', (fullPath) => this.handleFileSystemEvent('unlink', fullPath));
    // Without a permanent listener a late watcher error (EMFILE, EPERM, ...) would crash the process.
    this.watcher.on('error', (err) => this.reportWatchError(err));

    this.rootCheckTimer = setInterval(() => this.checkHealth(), 3000);
    this.rootCheckTimer.unref();

    return checkpoint;
  }

  public async stop(): Promise<void> {
    if (this.rootCheckTimer) {
      clearInterval(this.rootCheckTimer);
      this.rootCheckTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Creates an invisible Git checkpoint (via `git stash create` or `HEAD`)
   * plus a fast local file snapshot for reliable single-file and full rollback.
   */
  public createCheckpoint(): CheckpointInfo {
    this.initialSnapshot.clear();
    this.existedAtStart.clear();
    this.checkpointSha = null;

    if (this.dryRun) {
      this.checkpoint = {
        type: 'memory-snapshot',
        ref: 'demo',
        createdAt: Date.now(),
        snapshottedFiles: 0,
      };
      this.recordActivity({
        type: 'checkpoint-created',
        message: 'Demo session: simulated checkpoint, no files are read or written',
        severity: 'info',
      });
      return this.checkpoint;
    }

    this.captureDirectorySnapshot(this.rootDir);

    let type: CheckpointInfo['type'] = 'memory-snapshot';
    let ref = `snap-${Date.now().toString(36)}`;

    try {
      const insideGit = this.git(['rev-parse', '--is-inside-work-tree']);

      if (insideGit === 'true') {
        this.isGitRepo = true;
        // Try creating an invisible git stash commit object (leaves working tree untouched)
        const stashSha = this.git(['stash', 'create']);

        if (stashSha) {
          type = 'git-stash-commit';
          ref = stashSha.slice(0, 12);
          this.checkpointSha = stashSha;
        } else {
          const headSha = this.git(['rev-parse', 'HEAD']);
          if (headSha) {
            type = 'git-head';
            ref = headSha.slice(0, 7);
            this.checkpointSha = headSha;
          }
        }
      }
    } catch {
      // Not a git repository, git missing, or a repository without commits: memory snapshot only
      if (!this.checkpointSha) {
        this.isGitRepo = false;
      }
    }

    this.checkpoint = {
      type,
      ref,
      createdAt: Date.now(),
      snapshottedFiles: this.initialSnapshot.size,
    };

    this.recordActivity({
      type: 'checkpoint-created',
      message: `Session checkpoint created (${type}: ${ref}, ${this.initialSnapshot.size} files snapshotted)`,
      severity: 'info',
    });

    return this.checkpoint;
  }

  /** True if the checkpoint commit contains this path (i.e. git can restore it). */
  private isInCheckpointCommit(relPath: string): boolean {
    try {
      execFileSync('git', ['cat-file', '-e', `${this.checkpointSha}:${relPath}`], {
        cwd: this.rootDir,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  }

  private captureDirectorySnapshot(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name === CONFIG_FILENAME) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = this.toRelPath(fullPath);

      if (entry.isDirectory()) {
        this.captureDirectorySnapshot(fullPath);
      } else if (entry.isSymbolicLink()) {
        // Remember that the link existed so a rollback never removes it; its target is not copied.
        this.existedAtStart.add(relPath);
      } else if (entry.isFile()) {
        this.existedAtStart.add(relPath);
        // Never read .env* secret files into memory snapshots
        if (this.isEnvFile(relPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= SNAPSHOT_MAX_BYTES) {
            this.initialSnapshot.set(relPath, fs.readFileSync(fullPath));
          }
        } catch {
          // Ignore unreadable files
        }
      }
    }
  }

  /**
   * Returns true if the target path is a `.env*` file containing environment variables/secrets.
   * `.env*` files are strictly warn-only: their contents are never read into memory or overwritten.
   */
  public isEnvFile(targetPath: string): boolean {
    const base = path.posix.basename(toPosixPath(targetPath));
    return base === '.env' || base.startsWith('.env.');
  }

  public shouldIgnorePath(targetPath: string): boolean {
    const rel = toPosixPath(path.relative(this.rootDir, targetPath));
    if (!rel || rel === '.') return false;

    const segments = rel.split('/');
    for (const seg of segments) {
      if (IGNORED_DIRS.has(seg)) {
        return true;
      }
    }

    const lastSeg = segments[segments.length - 1];
    if (
      lastSeg === CONFIG_FILENAME ||
      lastSeg.endsWith('.tsbuildinfo') ||
      /^\.!\d+!/.test(lastSeg)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Processes a file write/delete event (`add`, `change`, `unlink`).
   * Can also be invoked directly in tests or by chokidar listeners.
   */
  public handleFileSystemEvent(
    action: 'add' | 'change' | 'unlink',
    fullOrRelPath: string,
    now: number = Date.now(),
  ): void {
    const absPath = path.isAbsolute(fullOrRelPath)
      ? fullOrRelPath
      : path.join(this.rootDir, fullOrRelPath);
    const relPath = this.toRelPath(absPath);

    if (!relPath || relPath.startsWith('..') || this.shouldIgnorePath(absPath)) {
      return;
    }

    // Ignore events generated by our own rollback operations
    if (this.isOwnWriteEcho(relPath)) {
      return;
    }

    // Keep loopDetector synced with current config limit
    const cfg = this.configManager.getConfig();
    this.loopDetector.setMaxEditsPerFilePerMinute(cfg.limits.maxEditsPerFilePerMinute);

    this.modifiedFiles.add(relPath);

    // 1. Check protected file policy
    if (this.configManager.isProtectedFile(relPath)) {
      const envFile = this.isEnvFile(relPath);
      // Never read or overwrite .env* files — emit a warning alert only
      const attempt =
        !envFile && this.autoRollbackProtected ? this.performRollback(relPath) : null;
      const rolledBack = attempt?.outcome.ok ?? false;
      const event = this.recordActivity({
        type: 'protected-file',
        filePath: relPath,
        action,
        rolledBack,
        modifiedFilesCount: this.modifiedFiles.size,
        message: envFile
          ? `WARNING: Protected ENV file ${action} (${relPath}) — warn-only, secrets are never read or overwritten`
          : `Protected file touched: ${relPath}${rolledBack ? (this.dryRun ? ' (auto-revert simulated)' : ' (auto-reverted)') : ''}`,
        severity: envFile ? 'warn' : 'critical',
        timestamp: now,
      });
      if (attempt) this.reportRollback(relPath, attempt);
      this.emit('protected-file', event);
      return;
    }

    // 2. Check Loop / Thrashing Detector
    const loopResult = this.loopDetector.recordEdit(relPath, now);
    if (loopResult.triggered && loopResult.alert) {
      const attempt = this.autoRollbackOnLoop ? this.performRollback(relPath) : null;
      const rolledBack = attempt?.outcome.ok ?? false;
      const event = this.recordActivity({
        type: 'loop-detected',
        filePath: relPath,
        action,
        editCount: loopResult.editCount,
        rolledBack,
        modifiedFilesCount: this.modifiedFiles.size,
        message: `Circuit Breaker! Thrashing on ${relPath} (${loopResult.editCount} edits/min > ${loopResult.limit})${rolledBack ? (this.dryRun ? ' — rollback simulated' : ' — file rolled back') : ''}`,
        severity: 'critical',
        timestamp: now,
      });
      if (attempt) this.reportRollback(relPath, attempt);
      this.emit('loop-detected', { ...loopResult.alert, rolledBack, event } satisfies LoopAlert & {
        rolledBack: boolean;
        event: WatchActivityEvent;
      });
      return;
    }

    // 3. Emit standard file-edit event
    const editEvent = this.recordActivity({
      type: 'file-edit',
      filePath: relPath,
      action,
      editCount: loopResult.editCount,
      modifiedFilesCount: this.modifiedFiles.size,
      message: `${action.toUpperCase()}: ${relPath} (${loopResult.editCount}/${cfg.limits.maxEditsPerFilePerMinute} edits/min)`,
      severity: 'info',
      timestamp: now,
    });
    this.emit('file-edit', editEvent);

    // 4. Check file count limits (warn / hard-stop)
    const limitState = this.configManager.evaluateFileLimit(this.modifiedFiles.size);
    if (limitState !== 'ok' && limitState !== this.lastLimitState) {
      this.lastLimitState = limitState;
      if (limitState === 'warn') {
        const warnEvent = this.recordActivity({
          type: 'limit-warn',
          filePath: relPath,
          modifiedFilesCount: this.modifiedFiles.size,
          message: `Warning: ${this.modifiedFiles.size} files modified (warn threshold: ${cfg.limits.maxFilesWarn})`,
          severity: 'warn',
          timestamp: now,
        });
        this.emit('limit-warn', warnEvent);
      } else if (limitState === 'hard-stop') {
        const stopEvent = this.recordActivity({
          type: 'limit-hard-stop',
          filePath: relPath,
          modifiedFilesCount: this.modifiedFiles.size,
          message: `HARD STOP: ${this.modifiedFiles.size} files modified in ${cfg.mode.toUpperCase()} mode!`,
          severity: 'critical',
          timestamp: now,
        });
        this.emit('limit-hard-stop', stopEvent);
      }
    } else if (limitState === 'ok') {
      this.lastLimitState = 'ok';
    }
  }

  /**
   * Rolls back a single file to its state at session start.
   *
   * Safety contract:
   * - only paths inside the watched repository, never ignored paths (`.git`, `node_modules`, ...)
   * - `.env*` files are never read, overwritten or deleted
   * - a file is only removed if it was created during this session
   * - the version being replaced is kept in a private temp directory first
   */
  public rollbackFile(filePath: string): boolean {
    const attempt = this.performRollback(filePath);
    this.reportRollback(filePath, attempt);
    return attempt.outcome.ok;
  }

  /** Validates the path and restores the file, without writing to the activity log. */
  private performRollback(filePath: string): { relPath: string | null; outcome: RestoreOutcome } {
    const relPath = this.resolveInsideRoot(filePath);
    if (!relPath) {
      return {
        relPath: null,
        outcome: { ok: false, reason: 'outside the watched repository or an ignored path' },
      };
    }
    // Never overwrite or delete .env* secret files
    if (this.isEnvFile(relPath)) {
      return { relPath, outcome: { ok: false, action: 'unchanged' } };
    }
    const outcome = this.restoreFile(relPath);
    if (outcome.ok) {
      this.modifiedFiles.delete(relPath);
      this.lastLimitState = this.configManager.evaluateFileLimit(this.modifiedFiles.size);
    }
    return { relPath, outcome };
  }

  /** Writes the result of a rollback attempt to the activity log. */
  private reportRollback(
    requestedPath: string,
    attempt: { relPath: string | null; outcome: RestoreOutcome },
  ): void {
    const { relPath, outcome } = attempt;
    if (!relPath) {
      this.recordActivity({
        type: 'rollback-failed',
        message: `Refused to roll back ${this.describePath(requestedPath)}: ${outcome.reason}`,
        severity: 'warn',
      });
      return;
    }
    if (!outcome.ok) {
      // .env* files are skipped silently: the protected-file warning already says why
      if (!outcome.reason) return;
      this.recordActivity({
        type: 'rollback-failed',
        filePath: relPath,
        message: `Could not roll back ${relPath}: ${outcome.reason}`,
        severity: 'warn',
      });
      return;
    }

    const kept = outcome.backupPath ? ` (replaced version kept: ${outcome.backupPath})` : '';
    const what =
      outcome.action === 'removed'
        ? `Removed ${relPath} (created during this session)`
        : outcome.action === 'simulated'
          ? `Demo: would roll back ${relPath} to session checkpoint (no files touched)`
          : outcome.action === 'unchanged'
            ? `${relPath} is already at its session checkpoint state`
            : `Rolled back ${relPath} to session checkpoint`;
    this.recordActivity({
      type: 'rollback',
      filePath: relPath,
      rolledBack: true,
      modifiedFilesCount: this.modifiedFiles.size,
      message: `${what}${kept}`,
      severity: 'warn',
    });
  }

  /**
   * Panic Rollback: restores all modified files to the session checkpoint.
   */
  public panicRollbackAll(): PanicRollbackResult {
    const restoredFiles: string[] = [];
    const skippedFiles: string[] = [];
    const targets = new Set<string>([...this.modifiedFiles, ...this.initialSnapshot.keys()]);

    for (const relPath of targets) {
      if (this.isEnvFile(relPath)) continue;
      if (this.dryRun) {
        if (this.modifiedFiles.has(relPath)) restoredFiles.push(relPath);
        continue;
      }
      const absPath = path.join(this.rootDir, relPath);

      if (this.initialSnapshot.has(relPath)) {
        const original = this.initialSnapshot.get(relPath)!;
        let unchanged = false;
        try {
          unchanged = fs.existsSync(absPath) && fs.readFileSync(absPath).equals(original);
        } catch {
          unchanged = false;
        }
        if (unchanged) continue;
      } else if (!this.modifiedFiles.has(relPath)) {
        continue;
      }

      const outcome = this.restoreFile(relPath);
      if (outcome.ok) {
        restoredFiles.push(relPath);
      } else {
        skippedFiles.push(relPath);
      }
    }

    this.modifiedFiles.clear();
    this.loopDetector.resetAll();
    this.lastLimitState = 'ok';

    const kept = this.discardDir ? ` — replaced versions kept in ${this.discardDir}` : '';
    const skipped = skippedFiles.length
      ? `, ${skippedFiles.length} skipped (no checkpoint copy)`
      : '';
    const event = this.recordActivity({
      type: 'panic-rollback',
      rolledBack: true,
      modifiedFilesCount: 0,
      message: this.dryRun
        ? `Demo: PANIC ROLLBACK simulated for ${restoredFiles.length} file(s), no files touched`
        : `PANIC ROLLBACK executed: ${restoredFiles.length} file(s) restored to checkpoint (${this.checkpoint?.ref ?? 'initial'})${skipped}${kept}`,
      severity: 'critical',
    });
    this.emit('panic-rollback', event);

    return {
      restoredFiles,
      count: restoredFiles.length,
      skippedFiles,
    };
  }

  /**
   * Brings one file back to its session-start state. `relPath` must already be validated.
   */
  private restoreFile(relPath: string): RestoreOutcome {
    if (this.dryRun) {
      return { ok: true, action: 'simulated' };
    }

    const absPath = path.join(this.rootDir, relPath);
    const original = this.initialSnapshot.get(relPath);

    try {
      if (original) {
        let current: Buffer | null = null;
        try {
          current = fs.readFileSync(absPath);
        } catch {
          current = null;
        }
        if (current && current.equals(original)) {
          return { ok: true, action: 'unchanged' };
        }
        const backupPath = this.keepDiscardedCopy(relPath, absPath);
        this.ownWrites.set(relPath, { expected: original, until: Date.now() + OWN_WRITE_WINDOW_MS });
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, original);
        return { ok: true, action: 'restored', backupPath };
      }

      if (this.existedAtStart.has(relPath)) {
        // The file was there at session start but we hold no copy (larger than the snapshot
        // limit, unreadable, or a symlink). Git may still have it; otherwise leave it alone.
        if (this.isGitRepo && this.checkpointSha && this.isInCheckpointCommit(relPath)) {
          const backupPath = this.keepDiscardedCopy(relPath, absPath);
          try {
            execFileSync(
              'git',
              ['restore', `--source=${this.checkpointSha}`, '--worktree', '--', relPath],
              { cwd: this.rootDir, stdio: ['ignore', 'pipe', 'ignore'] },
            );
            this.ownWrites.set(relPath, {
              expected: fs.readFileSync(absPath),
              until: Date.now() + OWN_WRITE_WINDOW_MS,
            });
            return { ok: true, action: 'restored', backupPath };
          } catch {
            // Not tracked in the checkpoint commit: fall through and leave the file alone
          }
        }
        return {
          ok: false,
          reason: 'it existed at session start but no checkpoint copy is available, left untouched',
        };
      }

      // Not present at session start: the file was created during this session.
      if (fs.existsSync(absPath)) {
        const backupPath = this.keepDiscardedCopy(relPath, absPath);
        this.ownWrites.set(relPath, { expected: null, until: Date.now() + OWN_WRITE_WINDOW_MS });
        fs.unlinkSync(absPath);
        return { ok: true, action: 'removed', backupPath };
      }
      // Created and already gone again: that is the session-start state.
      return { ok: true, action: 'unchanged' };
    } catch (err) {
      this.ownWrites.delete(relPath);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Copies the version that is about to be replaced into a private temp directory.
   * Returns the copy's path, or undefined if there was nothing to keep.
   */
  private keepDiscardedCopy(relPath: string, absPath: string): string | undefined {
    if (!this.keepDiscarded || this.isEnvFile(relPath)) return undefined;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > DISCARD_MAX_BYTES) return undefined;
    } catch {
      return undefined;
    }
    try {
      if (!this.discardDir) {
        // mkdtemp creates the directory with mode 0700, so other local users cannot read the copies
        this.discardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-leash-discarded-'));
      }
      this.discardCounter += 1;
      const slot = path.join(this.discardDir, String(this.discardCounter).padStart(5, '0'));
      const target = path.join(slot, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(absPath, target);
      this.discardSlots.push(slot);
      while (this.discardSlots.length > DISCARD_MAX_COPIES) {
        const oldest = this.discardSlots.shift();
        if (oldest) fs.rmSync(oldest, { recursive: true, force: true });
      }
      return target;
    } catch {
      return undefined;
    }
  }

  /**
   * True if a file system event for `relPath` is the echo of our own rollback:
   * we touched the path recently and it still has exactly the state we left it in.
   */
  private isOwnWriteEcho(relPath: string): boolean {
    const own = this.ownWrites.get(relPath);
    if (!own) return false;
    if (Date.now() > own.until) {
      this.ownWrites.delete(relPath);
      return false;
    }
    const absPath = path.join(this.rootDir, relPath);
    try {
      if (own.expected === null) {
        if (!fs.existsSync(absPath)) return true;
      } else if (fs.readFileSync(absPath).equals(own.expected)) {
        return true;
      }
    } catch {
      // Fall through: treat as a foreign change
    }
    this.ownWrites.delete(relPath);
    return false;
  }

  /**
   * Validates a caller-supplied path and returns it relative to the repository root,
   * or null if it points outside the repository (also via symlinked directories) or at an ignored path.
   */
  private resolveInsideRoot(filePath: string): string | null {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      return null;
    }
    const absPath = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(this.rootDir, filePath);
    const relPath = this.toRelPath(absPath);
    if (!relPath || relPath === '.' || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return null;
    }
    const insideRoot = (candidate: string) =>
      candidate === this.rootDir || candidate.startsWith(this.rootDir + path.sep);

    // Resolve symlinks in the nearest existing parent directory
    let parent = path.dirname(path.join(this.rootDir, relPath));
    while (parent !== this.rootDir && insideRoot(parent) && !fs.existsSync(parent)) {
      parent = path.dirname(parent);
    }
    let realParent = parent;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      // Keep the lexical parent
    }
    if (!insideRoot(realParent)) {
      return null;
    }
    if (this.shouldIgnorePath(path.join(this.rootDir, relPath))) {
      return null;
    }
    return relPath;
  }

  private describePath(filePath: unknown): string {
    const text = typeof filePath === 'string' ? filePath : String(filePath);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  private reportWatchError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const event = this.recordActivity({
      type: 'watch-error',
      message: `File watcher error: ${message}`,
      severity: 'critical',
    });
    this.emit('watch-error', event);
  }

  /**
   * Verifies that the watched directory still exists and reports it once if it is gone.
   * Runs every few seconds while watching; callable directly by embedders and tests.
   */
  public checkHealth(): void {
    let exists = false;
    try {
      exists = fs.statSync(this.rootDir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists && !this.rootMissingReported) {
      this.rootMissingReported = true;
      const event = this.recordActivity({
        type: 'watch-error',
        message: `Watched directory is gone: ${this.rootDir} — nothing is being guarded any more`,
        severity: 'critical',
      });
      this.emit('watch-error', event);
    } else if (exists && this.rootMissingReported) {
      this.rootMissingReported = false;
    }
  }

  private toRelPath(absPath: string): string {
    let normalizedAbs = absPath;
    if (!normalizedAbs.startsWith(this.rootDir)) {
      try {
        const realParent = fs.realpathSync(path.dirname(absPath));
        normalizedAbs = path.join(realParent, path.basename(absPath));
      } catch {
        // Keep original absPath if parent dir no longer exists
      }
    }
    return toPosixPath(path.relative(this.rootDir, normalizedAbs));
  }

  private recordActivity(
    partial: Omit<WatchActivityEvent, 'id' | 'timestamp'> & { timestamp?: number },
  ): WatchActivityEvent {
    const event: WatchActivityEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: partial.timestamp ?? Date.now(),
      ...partial,
    };
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > 250) {
      this.recentEvents.length = 250;
    }
    this.emit('activity', event);
    return event;
  }
}
