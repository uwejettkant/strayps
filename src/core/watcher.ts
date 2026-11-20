import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  | 'checkpoint-created'
  | 'watch-error'
  | 'config-reload'
  | 'ignore-rules-changed'
  | 'process-alert'
  | 'process-recovered'
  | 'process-killed'
  | 'process-paused'
  | 'process-resumed';

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

/**
 * There is no automatic rollback. Protected files and thrashing raise an alarm; a file is only
 * restored by `revert`, one file at a time, after a person confirmed it. In a long session an automatic
 * rollback to the session start would throw away hours of good work.
 */
export interface RepoWatcherOptions {
  rootDir: string;
  configManager?: GuardConfigManager;
  loopDetector?: LoopDetector;
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

/**
 * A file left unchanged this long ends a series of changes. The version it had then is what
 * `revert` restores: the version before the latest series, never anything older.
 */
export const STABLE_AFTER_MS = 60_000;

/** A version of a file: its bytes, null if the file did not exist, undefined if no copy is held. */
type VersionContent = Buffer | null | undefined;

interface FileHistory {
  /** The file as the watcher last saw it, and since when. */
  current: VersionContent;
  currentSince: number;
  currentIsStart: boolean;
  /** The version before the latest series of changes: what `revert` restores. */
  stable: VersionContent;
  /** True while the stable version is the one from the session start. */
  stableIsStart: boolean;
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
  /** SHA-256 of the content we wrote, or null when we removed the file. */
  expectedHash: string | null;
  until: number;
}

interface RestoreOutcome {
  ok: boolean;
  action?: 'restored' | 'removed' | 'unchanged' | 'simulated';
  reason?: string;
  backupPath?: string;
  /** The file is back at its session-start version, so it no longer counts as modified. */
  backAtStart?: boolean;
  /** Restored with git from the session checkpoint (no copy in memory). */
  fromCheckpoint?: boolean;
}

/**
 * Git's view of the repository, read once at session start. Paths below are relative to the
 * watched directory; directories carry no trailing slash.
 */
interface GitIgnoreState {
  /** Directories git ignores as a whole (`git ls-files --directory` collapses them). */
  dirs: Set<string>;
  /** What git ignored at start (`dirs` and `files` grow later): it existed, its content is unknown. */
  ignoredAtStart: { dirs: Set<string>; files: Set<string> };
  /** Single ignored files outside those directories. */
  files: Set<string>;
  /** Files git does not ignore (tracked or untracked) and every directory above them. */
  known: Set<string>;
  /** Answers of `git check-ignore` for paths that appeared later. */
  asked: Map<string, boolean>;
  /** Directories git could not answer for (a submodule, an error): not asked again below them. */
  unanswerable: Set<string>;
  /** Files outside the watched tree that hold ignore rules (.git/info/exclude, git config). */
  ruleFiles: string[];
  /** Hash of their contents at session start; a hash, since git config can hold credentials. */
  ruleFingerprint: string;
  /** Hash of each `.gitignore` at session start, by directory ('' is the root). */
  gitignoreHashes: Map<string, string>;
  /** Set once the rules changed during the session: from then on git is not asked any more. */
  rulesChanged: boolean;
}

/** `git ls-files` of a large repository easily exceeds the 1 MB default of execFileSync. */
const GIT_LIST_MAX_BUFFER = 256 * 1024 * 1024;
/** Every git call here runs on the event loop; a hanging git must not freeze the dashboard or pause. */
const GIT_LIST_TIMEOUT_MS = 10_000;
const GIT_ASK_TIMEOUT_MS = 2_000;

/** A hash of the file, or 'missing'. Only the hash is kept: git config can hold credentials. */
function hashFile(file: string): string {
  // O_NONBLOCK: a FIFO put in place of a .gitignore must not block the watchdog in open()
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NONBLOCK);
  } catch {
    return 'missing';
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return `not-a-plain-file:${stat.mode}:${stat.size}`;
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } catch {
    return 'unreadable';
  } finally {
    fs.closeSync(fd);
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Opening with this flag fails on a symbolic link instead of following it (0 where unsupported). */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Opening a FIFO without it blocks until a writer appears: an agent's `mkfifo` froze the watchdog. */
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * Opens a path for reading only if it is a plain file under this one name: never through a
 * symbolic link at the path itself (O_NOFOLLOW), never a hard link (a second name of another file,
 * which could be .env or ~/.zshrc), never a FIFO or device. Returns the descriptor, null when the
 * path does not exist, undefined for anything else.
 */
function openPlainFile(absPath: string): number | null | undefined {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.nlink === 1) return fd;
  } catch {
    // fall through
  }
  fs.closeSync(fd);
  return undefined;
}

/**
 * Reads a plain file (see openPlainFile): an agent can replace a file with a link to ~/.zshrc or
 * to .env, and its target must neither be read nor written. Returns null when the path does not
 * exist, undefined when it is not a plain file of its own, larger than `maxBytes` or unreadable.
 */
function readPlainFile(absPath: string, maxBytes: number): Buffer | null | undefined {
  const fd = openPlainFile(absPath);
  if (fd === null || fd === undefined) return fd;
  try {
    if (fs.fstatSync(fd).size > maxBytes) return undefined;
    return fs.readFileSync(fd);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** SHA-256 of a plain file (see openPlainFile), read in chunks; null when missing, else undefined. */
function hashPlainFile(absPath: string): string | null | undefined {
  const fd = openPlainFile(absPath);
  if (fd === null || fd === undefined) return fd;
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let read = fs.readSync(fd, chunk); read > 0; read = fs.readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes a plain file. An existing file is opened without truncating and checked first: a symbolic
 * link at the path fails the open, and a hard link (a second name of a file elsewhere, e.g. ~/.zshrc)
 * is refused before a byte changes. A missing file is created, never through a link.
 */
function writePlainFile(absPath: string, content: Buffer): void {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fd = fs.openSync(absPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o666);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('it is not a plain file of its own (a hard link or a special file), left untouched');
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, content, 0, content.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

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
  private keepDiscarded: boolean;
  private initialSnapshot: Map<string, Buffer> = new Map();
  /** Versions of every file changed in this session (see FileHistory). */
  private histories: Map<string, FileHistory> = new Map();
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
  /** What git ignores in this repository; null outside git or when git fails. */
  private gitIgnore: GitIgnoreState | null = null;

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
      // A link to a directory outside the repository would make its files look like repository
      // files, to be read into memory on every change; the snapshot walk does not follow links either
      followSymlinks: false,
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
    this.histories.clear();
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

    this.gitIgnore = this.readGitIgnore();
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
        timeout: GIT_ASK_TIMEOUT_MS,
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
      timeout: GIT_LIST_TIMEOUT_MS,
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
      const fullPath = path.join(dir, entry.name);
      // One rule for what is snapshotted, watched and restorable: the snapshot of a virtual
      // environment once held 224 MB of files nobody would ever restore.
      if (this.shouldIgnorePath(fullPath)) continue;
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
        const content = readPlainFile(fullPath, SNAPSHOT_MAX_BYTES);
        if (content) this.initialSnapshot.set(relPath, content);
      }
    }
  }

  /**
   * Returns true if the target path is a `.env*` file containing environment variables/secrets.
   * `.env*` files are strictly warn-only: their contents are never read into memory or overwritten.
   */
  public isEnvFile(targetPath: string): boolean {
    // Matches what the default glob .env* protects (.envrc, .env-local, .env.production …), in any
    // spelling: on macOS ".ENV" opens .env, and a case-sensitive test let it be read and deleted.
    return path.posix.basename(toPosixPath(targetPath)).toLowerCase().startsWith('.env');
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

    if (!this.gitIgnore) return false;
    // A .gitignore is always watched, also one that ignores itself: its edit must reach
    // handleFileSystemEvent, which notes that the rules changed.
    if (lastSeg === '.gitignore') return false;
    if (!this.isGitIgnored(rel, segments)) return false;
    // A protected file stays watched even when git ignores it: .env is in nearly every
    // .gitignore, and an alarm on it is the point of protecting it. An ignored directory is still
    // entered when a protected file could be in it; its other files stay ignored.
    if (this.configManager.isProtectedFile(rel)) return false;
    return !(isDirectory(targetPath) && this.mayHoldProtectedFiles(rel));
  }

  /**
   * True if a protected glob could match below the directory `rel`: a glob without a slash
   * (`.env*`, `docker-compose*.yml`) matches a file name at any depth, a glob with a fixed
   * directory (`secrets/**`) only below that directory.
   */
  private mayHoldProtectedFiles(rel: string): boolean {
    const dir = `${rel}/`;
    return this.configManager.getConfig().protectedFiles.some((pattern) => {
      const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!normalized.includes('/')) return true;
      const fixed = normalized.slice(0, normalized.search(/[*?]|$/));
      return fixed.startsWith(dir) || dir.startsWith(fixed);
    });
  }

  private isGitIgnored(rel: string, segments: string[]): boolean {
    const state = this.gitIgnore!;
    for (let i = 1; i <= segments.length; i++) {
      if (state.dirs.has(segments.slice(0, i).join('/'))) return true;
    }
    if (state.files.has(rel)) return true;
    if (state.known.has(rel)) return false;
    const cached = state.asked.get(rel);
    if (cached !== undefined) return cached;
    for (let i = 1; i < segments.length; i++) {
      if (state.unanswerable.has(segments.slice(0, i).join('/'))) return false;
    }

    // An agent can write ignore rules itself: into .gitignore, or unseen into .git/info/exclude
    // or the git config. Rules that changed during the session would hide every file it creates
    // from then on, so a new path is only judged by git while the rules are the ones from the start.
    if (!this.ignoreRulesUnchanged(segments)) return false;

    // `--` keeps a file named like an option a path. Exit code 0: ignored, 1: not ignored,
    // anything else (a submodule, an error, a timeout): not answered, so the path stays watched.
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], {
        cwd: this.rootDir,
        stdio: 'ignore',
        timeout: GIT_ASK_TIMEOUT_MS,
      });
      ignored = true;
    } catch (err) {
      if ((err as { status?: number | null }).status !== 1) {
        state.unanswerable.add(segments.slice(0, -1).join('/') || rel);
      }
    }
    state.asked.set(rel, ignored);
    if (ignored && isDirectory(path.join(this.rootDir, rel))) state.dirs.add(rel);
    return ignored;
  }

  /**
   * Compares the rules that apply to a new path with the ones from the start: every .gitignore
   * from the root down to its directory, and the rule files outside the tree. chokidar can ask
   * about a new file before it reports the new .gitignore next to it, so events alone are too late.
   */
  private ignoreRulesUnchanged(segments: string[]): boolean {
    const state = this.gitIgnore!;
    if (state.rulesChanged) return false;
    for (let i = 0; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      const now = hashFile(path.join(this.rootDir, dir, '.gitignore'));
      if (now !== (state.gitignoreHashes.get(dir) ?? 'missing')) {
        this.markIgnoreRulesChanged(dir ? `${dir}/.gitignore` : '.gitignore');
        return false;
      }
    }
    if (this.fingerprint(state.ruleFiles) !== state.ruleFingerprint) {
      this.markIgnoreRulesChanged('the git ignore settings');
    }
    return !state.rulesChanged;
  }

  private fingerprint(files: string[]): string {
    return createHash('sha256').update(files.map(hashFile).join('\n')).digest('hex');
  }

  /** True if git ignored this path, or a directory above it, when the session started. */
  private wasIgnoredAtStart(relPath: string): boolean {
    const start = this.gitIgnore?.ignoredAtStart;
    if (!start) return false;
    if (start.files.has(relPath)) return true;
    const segments = relPath.split('/');
    for (let i = 1; i <= segments.length; i++) {
      if (start.dirs.has(segments.slice(0, i).join('/'))) return true;
    }
    return false;
  }

  private markIgnoreRulesChanged(where: string): void {
    const state = this.gitIgnore;
    if (!state || state.rulesChanged) return;
    state.rulesChanged = true;
    this.recordActivity({
      type: 'ignore-rules-changed',
      message: `Ignore rules changed during the session (${where}); files created from now on are watched even if git ignores them`,
      severity: 'warn',
    });
  }

  /** Reads what git ignores. Outside a git work tree, or if git fails, the fixed list alone applies. */
  private readGitIgnore(): GitIgnoreState | null {
    const run = (args: string[], maxBuffer = 1024 * 1024): string =>
      execFileSync('git', args, {
        cwd: this.rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        maxBuffer,
        timeout: GIT_LIST_TIMEOUT_MS,
      });
    const list = (args: string[]): string[] =>
      run(['ls-files', '-z', ...args], GIT_LIST_MAX_BUFFER)
        .split('\0')
        .filter((entry) => entry.length > 0);
    try {
      if (run(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
      // A directory that the enclosing repository ignores (a scratch folder) would be ignored as
      // a whole: watch it like a directory outside git instead of not at all.
      try {
        run(['check-ignore', '-q', '--', '.']);
        return null;
      } catch {
        // not ignored: go on
      }
      const ignored = list(['--others', '--ignored', '--exclude-standard', '--directory']);
      const notIgnored = list(['--cached', '--others', '--exclude-standard']);
      const gitPath = (name: string) => path.resolve(this.rootDir, run(['rev-parse', '--git-path', name]).trim());
      let excludesFile: string;
      try {
        excludesFile = path.resolve(this.rootDir, run(['config', '--path', '--get', 'core.excludesFile']).trim());
      } catch {
        excludesFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
      }
      // Every config file git reads (system, global, includes, worktree), as git reports them:
      // with -z the output alternates origin and entry. A config file that does not exist yet
      // (the global one) is watched too, since creating it can set core.excludesFile.
      const configOrigins = new Set<string>([
        gitPath('config'),
        process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), '.gitconfig'),
        path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'config'),
      ]);
      try {
        const tokens = run(['config', '--list', '--show-origin', '-z']).split('\0');
        for (let i = 0; i < tokens.length; i += 2) {
          if (tokens[i].startsWith('file:')) configOrigins.add(path.resolve(this.rootDir, tokens[i].slice(5)));
        }
      } catch {
        // the fixed candidates above still apply
      }
      const ruleFiles = [gitPath('info/exclude'), excludesFile, ...configOrigins];
      const state: GitIgnoreState = {
        dirs: new Set(),
        ignoredAtStart: { dirs: new Set(), files: new Set() },
        files: new Set(),
        known: new Set(),
        asked: new Map(),
        unanswerable: new Set(),
        ruleFiles,
        ruleFingerprint: this.fingerprint(ruleFiles),
        gitignoreHashes: new Map(),
        rulesChanged: false,
      };
      for (const entry of ignored) {
        if (entry.endsWith('/')) state.dirs.add(entry.slice(0, -1));
        else state.files.add(entry);
      }
      state.ignoredAtStart = { dirs: new Set(state.dirs), files: new Set(state.files) };
      for (const entry of [...notIgnored, ...state.files]) {
        const parts = entry.split('/');
        if (parts[parts.length - 1] === '.gitignore') {
          const dir = parts.slice(0, -1).join('/');
          state.gitignoreHashes.set(dir, hashFile(path.join(this.rootDir, entry)));
        }
      }
      for (const entry of notIgnored) {
        const parts = entry.split('/');
        for (let i = 1; i <= parts.length; i++) state.known.add(parts.slice(0, i).join('/'));
      }
      return state;
    } catch {
      return null;
    }
  }

  /** The version a file had at session start (see VersionContent). */
  private initialVersion(relPath: string): VersionContent {
    const copy = this.initialSnapshot.get(relPath);
    if (copy) return copy;
    return this.existedAtStart.has(relPath) || this.wasIgnoredAtStart(relPath) ? undefined : null;
  }

  /**
   * Reads the file as it is now; undefined when it is too large, unreadable or a symbolic link
   * (a link's target is never read: it may be .env or a file outside the repository).
   */
  private readVersion(relPath: string): VersionContent {
    return readPlainFile(path.join(this.rootDir, relPath), SNAPSHOT_MAX_BYTES);
  }

  /**
   * Records a change of a file at time `now`. If the version before it had been left alone for
   * STABLE_AFTER_MS, a series of changes ended there and that version becomes the rollback target.
   */
  private trackChange(relPath: string, now: number): void {
    // .env* contents are never read, and the demo reads nothing at all
    const readable = !this.isEnvFile(relPath) && !this.dryRun;
    const start = readable ? this.initialVersion(relPath) : undefined;
    const history = this.histories.get(relPath) ?? {
      current: start,
      currentSince: Number.NEGATIVE_INFINITY,
      currentIsStart: true,
      stable: start,
      stableIsStart: true,
    };
    if (now - history.currentSince >= STABLE_AFTER_MS) {
      history.stable = history.current;
      history.stableIsStart = history.currentIsStart;
    }
    history.current = readable ? this.readVersion(relPath) : undefined;
    history.currentSince = now;
    history.currentIsStart = false;
    this.histories.set(relPath, history);
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

    if (!relPath || relPath.startsWith('..')) return;
    // Checked before the ignore rules, which this very edit may change
    if (path.posix.basename(relPath) === '.gitignore') this.markIgnoreRulesChanged(relPath);
    if (this.shouldIgnorePath(absPath)) return;

    // Ignore events generated by our own rollback operations
    if (this.isOwnWriteEcho(relPath)) {
      return;
    }

    // Keep loopDetector synced with current config limit
    const cfg = this.configManager.getConfig();
    this.loopDetector.setMaxEditsPerFilePerMinute(cfg.limits.maxEditsPerFilePerMinute);

    this.modifiedFiles.add(relPath);
    this.trackChange(relPath, now);

    // 1. Protected files: an alarm, never an automatic rollback
    if (this.configManager.isProtectedFile(relPath)) {
      const envFile = this.isEnvFile(relPath);
      const verb = action === 'add' ? 'created' : action === 'unlink' ? 'deleted' : 'changed';
      const event = this.recordActivity({
        type: 'protected-file',
        filePath: relPath,
        action,
        modifiedFilesCount: this.modifiedFiles.size,
        message: envFile
          ? `WARNING: Protected ENV file ${action} (${relPath}) — warn-only, secrets are never read or overwritten`
          : `Protected file ${verb}: ${relPath} (revert restores the version before this change)`,
        severity: envFile ? 'warn' : 'critical',
        timestamp: now,
      });
      this.emit('protected-file', event);
      return;
    }

    // 2. Thrashing: one alarm per series of edits, never an automatic rollback
    const loopResult = this.loopDetector.recordEdit(relPath, now);
    if (loopResult.triggered && loopResult.firstTrip && loopResult.alert) {
      const seconds = Math.round(loopResult.alert.windowMs / 1000);
      const event = this.recordActivity({
        type: 'loop-detected',
        filePath: relPath,
        action,
        editCount: loopResult.editCount,
        modifiedFilesCount: this.modifiedFiles.size,
        message: `Circuit breaker: ${relPath} changed ${loopResult.editCount} times within ${seconds} s (limit ${loopResult.limit}); revert restores the version before this series`,
        severity: 'critical',
        timestamp: now,
      });
      this.emit('loop-detected', { ...loopResult.alert, event } satisfies LoopAlert & {
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
          message: `HARD STOP: ${this.modifiedFiles.size} files modified (limit ${cfg.limits.maxFilesHardStop})`,
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
   * Rolls a single file back to its last stable version: the version it had before its latest
   * series of changes (see STABLE_AFTER_MS), never anything older.
   *
   * Safety contract:
   * - only paths inside the watched repository, never ignored paths (`.git`, `node_modules`, ...)
   * - `.env*` files are never read, overwritten or deleted
   * - a file is only removed if it did not exist before its latest series of changes
   * - the version being replaced is kept in a private temp directory first
   */
  public rollbackFile(filePath: string): boolean {
    const attempt = this.performRollback(filePath);
    this.reportRollback(filePath, attempt);
    return attempt.outcome.ok;
  }

  /** Validates the path and restores the file, without writing to the activity log. */
  private performRollback(
    filePath: string,
    now: number = Date.now(),
  ): { relPath: string | null; outcome: RestoreOutcome } {
    const relPath = this.resolveInsideRoot(filePath);
    if (!relPath) {
      return {
        relPath: null,
        outcome: { ok: false, reason: 'outside the watched repository or an ignored path' },
      };
    }
    // Never overwrite or delete .env* secret files
    if (this.isEnvFile(relPath)) {
      return {
        relPath,
        outcome: { ok: false, action: 'unchanged', reason: 'it is a .env file; agent-leash never reads or writes those' },
      };
    }
    // Only a file that changed in this session has a version to go back to. Any other name, even
    // one that opens an existing file (another spelling on macOS), has no history and would be
    // taken for a file to delete.
    if (!this.modifiedFiles.has(relPath)) {
      return { relPath, outcome: { ok: false, reason: 'it was not changed in this session, left untouched' } };
    }
    const outcome = this.restoreFile(relPath, now);
    // A file restored to a version from the middle of the session still differs from the start
    if (outcome.ok && outcome.backAtStart) {
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
        ? `Removed ${relPath} (it did not exist before its latest changes)`
        : outcome.action === 'simulated'
          ? `Demo: would roll back ${relPath} to the version before its latest changes (no files touched)`
          : outcome.action === 'unchanged'
            ? `${relPath} is already at the version before its latest changes`
            : outcome.fromCheckpoint
              ? `Rolled back ${relPath} to the version before its latest changes (from the session checkpoint)`
              : `Rolled back ${relPath} to the version before its latest changes`;
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
   * Brings one file back to its last stable version. `relPath` must already be validated.
   */
  private restoreFile(relPath: string, now: number = Date.now()): RestoreOutcome {
    if (this.dryRun) {
      return { ok: true, action: 'simulated', backAtStart: true };
    }

    const absPath = path.join(this.rootDir, relPath);
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          reason:
            'it is a symbolic link now; agent-leash never writes through a link or copies its target. Restore it yourself (for example with git checkout)',
        };
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        return {
          ok: false,
          reason: 'it is not a plain file of its own now (a hard link to another file, or a special file); agent-leash never writes to it',
        };
      }
    } catch {
      // Missing: nothing to follow
    }
    // resolveInsideRoot checked the parent directories; the agent can swap one for a link to ~
    // after that check, so check again right before anything is read, written or removed
    if (!this.parentInsideRoot(absPath)) {
      return { ok: false, reason: 'a directory on its path now leads outside the repository, left untouched' };
    }
    const history = this.histories.get(relPath);
    const target = history ? history.stable : this.initialVersion(relPath);
    const targetIsStart = history ? history.stableIsStart : true;
    const startCopy = this.initialSnapshot.get(relPath);
    const backAtStart =
      targetIsStart ||
      (target instanceof Buffer && startCopy !== undefined && target.equals(startCopy)) ||
      (target === null && !this.existedAtStart.has(relPath) && !this.wasIgnoredAtStart(relPath));
    // After a rollback the restored version is the file's current one
    const remember = (content: VersionContent) => {
      if (!history) return;
      history.current = content;
      history.currentSince = now;
      history.currentIsStart = targetIsStart;
    };

    try {
      if (target instanceof Buffer) {
        if (hashPlainFile(absPath) === sha256(target)) {
          remember(target);
          return { ok: true, action: 'unchanged', backAtStart };
        }
        const backupPath = this.keepDiscardedCopy(relPath, absPath);
        this.ownWrites.set(relPath, { expectedHash: sha256(target), until: Date.now() + OWN_WRITE_WINDOW_MS });
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        if (!this.parentInsideRoot(absPath)) {
          this.ownWrites.delete(relPath);
          return { ok: false, reason: 'a directory on its path now leads outside the repository, left untouched' };
        }
        // O_NOFOLLOW and the hard-link check: a link put at the path after the checks above makes it fail
        writePlainFile(absPath, target);
        remember(target);
        return { ok: true, action: 'restored', backupPath, backAtStart };
      }

      if (target === null) {
        // The file did not exist before its latest series of changes: it was created in this session
        if (fs.existsSync(absPath)) {
          const backupPath = this.keepDiscardedCopy(relPath, absPath);
          if (!this.parentInsideRoot(absPath)) {
            return { ok: false, reason: 'a directory on its path now leads outside the repository, left untouched' };
          }
          this.ownWrites.set(relPath, { expectedHash: null, until: Date.now() + OWN_WRITE_WINDOW_MS });
          fs.unlinkSync(absPath);
          remember(null);
          return { ok: true, action: 'removed', backupPath, backAtStart };
        }
        remember(null);
        return { ok: true, action: 'unchanged', backAtStart };
      }

      // No copy of the target version is held (larger than the snapshot limit, unreadable, or a
      // symlink). Git can bring back the session-start version, but only when that is the last
      // stable one: an older version would undo more than the latest series of changes.
      if (
        targetIsStart &&
        this.existedAtStart.has(relPath) &&
        this.isGitRepo &&
        this.checkpointSha &&
        this.isInCheckpointCommit(relPath)
      ) {
        const backupPath = this.keepDiscardedCopy(relPath, absPath);
        try {
          execFileSync(
            'git',
            // literal: a file named with *, [ or : would otherwise be a pattern for several files
            ['--literal-pathspecs', 'restore', `--source=${this.checkpointSha}`, '--worktree', '--', relPath],
            { cwd: this.rootDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_LIST_TIMEOUT_MS },
          );
          // A hash, read in chunks: the file is larger than the snapshot limit
          const restoredHash = hashPlainFile(absPath);
          if (typeof restoredHash === 'string') {
            this.ownWrites.set(relPath, { expectedHash: restoredHash, until: Date.now() + OWN_WRITE_WINDOW_MS });
          }
          remember(undefined);
          return { ok: true, action: 'restored', backupPath, backAtStart: true, fromCheckpoint: true };
        } catch {
          // Not tracked in the checkpoint commit: leave the file alone
        }
      }
      return {
        ok: false,
        reason: 'no copy of its last stable version is available (too large or unreadable), left untouched',
      };
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
    // Never through a link: its target may be .env or a file outside the repository
    const content = readPlainFile(absPath, DISCARD_MAX_BYTES);
    if (!content) return undefined;
    try {
      if (!this.discardDir) {
        // mkdtemp creates the directory with mode 0700, so other local users cannot read the copies
        this.discardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-leash-discarded-'));
      }
      this.discardCounter += 1;
      const slot = path.join(this.discardDir, String(this.discardCounter).padStart(5, '0'));
      const target = path.join(slot, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode: 0o600 });
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
      if (own.expectedHash === null) {
        if (!fs.existsSync(absPath)) return true;
      } else if (hashPlainFile(absPath) === own.expectedHash) {
        return true;
      }
    } catch {
      // Fall through: treat as a foreign change
    }
    this.ownWrites.delete(relPath);
    return false;
  }

  /** True if the directory holding `absPath` is, after resolving links, still inside the repository. */
  private parentInsideRoot(absPath: string): boolean {
    let parent = path.dirname(absPath);
    while (parent !== this.rootDir && parent.startsWith(this.rootDir + path.sep) && !fs.existsSync(parent)) {
      parent = path.dirname(parent);
    }
    try {
      const real = fs.realpathSync(parent);
      return real === this.rootDir || real.startsWith(this.rootDir + path.sep);
    } catch {
      return false;
    }
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
