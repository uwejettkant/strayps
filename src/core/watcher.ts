import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
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
  | 'panic-rollback'
  | 'checkpoint-created';

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

export class RepoWatcher extends EventEmitter {
  public readonly rootDir: string;
  public readonly configManager: GuardConfigManager;
  public readonly loopDetector: LoopDetector;

  private watcher: FSWatcher | null = null;
  private autoRollbackOnLoop: boolean;
  private autoRollbackProtected: boolean;
  private initialSnapshot: Map<string, Buffer> = new Map();
  private modifiedFiles: Set<string> = new Set();
  private suppressedPaths: Map<string, number> = new Map();
  private checkpoint: CheckpointInfo | null = null;
  private recentEvents: WatchActivityEvent[] = [];
  private isGitRepo: boolean = false;
  private lastLimitState: 'ok' | 'warn' | 'hard-stop' = 'ok';

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

  /**
   * Starts the file watcher and creates an initial Git / file-diff snapshot checkpoint.
   */
  public async start(): Promise<CheckpointInfo> {
    if (this.watcher) {
      return this.checkpoint!;
    }

    const checkpoint = this.createCheckpoint();

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

    return checkpoint;
  }

  public async stop(): Promise<void> {
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
    this.captureDirectorySnapshot(this.rootDir);

    let type: CheckpointInfo['type'] = 'memory-snapshot';
    let ref = `snap-${Date.now().toString(36)}`;

    try {
      const insideGit = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();

      if (insideGit === 'true') {
        this.isGitRepo = true;
        // Try creating an invisible git stash commit object (leaves working tree untouched)
        const stashSha = execFileSync('git', ['stash', 'create'], {
          cwd: this.rootDir,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
        }).trim();

        if (stashSha) {
          type = 'git-stash-commit';
          ref = stashSha.slice(0, 12);
        } else {
          const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: this.rootDir,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
          }).trim();
          if (headSha) {
            type = 'git-head';
            ref = headSha;
          }
        }
      }
    } catch {
      this.isGitRepo = false;
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
      } else if (entry.isFile()) {
        // Never read .env* secret files into memory snapshots
        if (this.isEnvFile(relPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          // Snapshot files up to 5MB in memory
          if (stat.size <= 5 * 1024 * 1024) {
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
    const normalized = targetPath.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    return base === '.env' || base.startsWith('.env.');
  }

  public shouldIgnorePath(targetPath: string): boolean {
    const rel = path.relative(this.rootDir, targetPath).replace(/\\/g, '/');
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
    const suppressedUntil = this.suppressedPaths.get(relPath);
    if (suppressedUntil && now < suppressedUntil) {
      return;
    }

    // Keep loopDetector synced with current config limit
    const cfg = this.configManager.getConfig();
    this.loopDetector.setMaxEditsPerFilePerMinute(cfg.limits.maxEditsPerFilePerMinute);

    this.modifiedFiles.add(relPath);

    // 1. Check protected file policy
    if (this.configManager.isProtectedFile(relPath)) {
      const envFile = this.isEnvFile(relPath);
      let rolledBack = false;
      // Never read or overwrite .env* files — emit a warning alert only
      if (!envFile && this.autoRollbackProtected) {
        rolledBack = this.rollbackFile(relPath);
      }
      const event = this.recordActivity({
        type: 'protected-file',
        filePath: relPath,
        action,
        rolledBack,
        modifiedFilesCount: this.modifiedFiles.size,
        message: envFile
          ? `WARNING: Protected ENV file ${action} (${relPath}) — warn-only, secrets are never read or overwritten`
          : `Protected file touched: ${relPath}${rolledBack ? ' (auto-reverted)' : ''}`,
        severity: envFile ? 'warn' : 'critical',
        timestamp: now,
      });
      this.emit('protected-file', event);
      return;
    }

    // 2. Check Loop / Thrashing Detector
    const loopResult = this.loopDetector.recordEdit(relPath, now);
    if (loopResult.triggered && loopResult.alert) {
      let rolledBack = false;
      if (this.autoRollbackOnLoop) {
        rolledBack = this.rollbackFile(relPath);
      }
      const event = this.recordActivity({
        type: 'loop-detected',
        filePath: relPath,
        action,
        editCount: loopResult.editCount,
        rolledBack,
        modifiedFilesCount: this.modifiedFiles.size,
        message: `Circuit Breaker! Thrashing on ${relPath} (${loopResult.editCount} edits/min > ${loopResult.limit})${rolledBack ? ' — file rolled back' : ''}`,
        severity: 'critical',
        timestamp: now,
      });
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
    }
  }

  /**
   * Rolls back a single file to its state at session start using `git checkout`
   * and/or the initial session snapshot.
   */
  public rollbackFile(filePath: string): boolean {
    const relPath = this.toRelPath(
      path.isAbsolute(filePath) ? filePath : path.join(this.rootDir, filePath),
    );
    // Never overwrite or delete .env* secret files
    if (this.isEnvFile(relPath)) {
      return false;
    }
    const absPath = path.join(this.rootDir, relPath);

    // Suppress chokidar feedback for this path for 400ms
    this.suppressedPaths.set(relPath, Date.now() + 400);

    let restored = false;

    // Try git checkout first if in a git repository and file was tracked
    if (this.isGitRepo) {
      try {
        const refArgs =
          this.checkpoint?.type === 'git-stash-commit'
            ? [this.checkpoint.ref, '--', relPath]
            : ['--', relPath];
        execFileSync('git', ['checkout', ...refArgs], {
          cwd: this.rootDir,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        restored = true;
      } catch {
        // Fallback to snapshot map below
      }
    }

    // Ensure exact content restoration from initialSnapshot (covers dirty state & non-git dirs)
    if (this.initialSnapshot.has(relPath)) {
      try {
        const originalBuffer = this.initialSnapshot.get(relPath)!;
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, originalBuffer);
        restored = true;
      } catch {
        // Ignore write error
      }
    } else if (!restored) {
      // File did not exist at session start -> remove newly created file
      try {
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          restored = true;
        }
      } catch {
        // Ignore unlink error
      }
    }

    if (restored) {
      this.recordActivity({
        type: 'rollback',
        filePath: relPath,
        rolledBack: true,
        modifiedFilesCount: this.modifiedFiles.size,
        message: `Rolled back ${relPath} to session checkpoint`,
        severity: 'warn',
      });
    }

    return restored;
  }

  /**
   * Panic Rollback: restores all modified files to the session checkpoint.
   */
  public panicRollbackAll(): { restoredFiles: string[]; count: number } {
    const restoredFiles: string[] = [];
    const targets = new Set<string>([
      ...this.modifiedFiles,
      ...this.initialSnapshot.keys(),
    ]);

    for (const relPath of targets) {
      if (this.isEnvFile(relPath)) continue;
      const absPath = path.join(this.rootDir, relPath);
      this.suppressedPaths.set(relPath, Date.now() + 600);

      if (this.initialSnapshot.has(relPath)) {
        const original = this.initialSnapshot.get(relPath)!;
        let needsWrite = true;
        if (fs.existsSync(absPath)) {
          try {
            const current = fs.readFileSync(absPath);
            if (current.equals(original)) {
              needsWrite = false;
            }
          } catch {
            needsWrite = true;
          }
        }
        if (needsWrite) {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, original);
          restoredFiles.push(relPath);
        }
      } else if (this.modifiedFiles.has(relPath) && fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
          restoredFiles.push(relPath);
        } catch {
          // Ignore
        }
      }
    }

    this.modifiedFiles.clear();
    this.loopDetector.resetAll();
    this.lastLimitState = 'ok';

    const event = this.recordActivity({
      type: 'panic-rollback',
      rolledBack: true,
      modifiedFilesCount: 0,
      message: `PANIC ROLLBACK executed: ${restoredFiles.length} file(s) restored to checkpoint (${this.checkpoint?.ref ?? 'initial'})`,
      severity: 'critical',
    });
    this.emit('panic-rollback', event);

    return {
      restoredFiles,
      count: restoredFiles.length,
    };
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
    return path.relative(this.rootDir, normalizedAbs).replace(/\\/g, '/');
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
