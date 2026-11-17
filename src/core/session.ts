import { EventEmitter } from 'node:events';
import { type GuardConfig, GuardConfigManager, parseMode } from './guard-config.js';
import {
  type MonitoredProcess,
  type ProcessKilledEvent,
  ProcessMonitor,
} from './process-monitor.js';
import {
  type CheckpointInfo,
  RepoWatcher,
  type WatchActivityEvent,
  type WatchEventType,
} from './watcher.js';

export interface WatchdogSessionDeps {
  rootDir: string;
  configManager: GuardConfigManager;
  watcher: RepoWatcher;
  processMonitor: ProcessMonitor;
}

/** One consistent view of the watchdog state. The dashboard and the terminal UI both render this. */
export interface StatusSnapshot {
  rootDir: string;
  config: GuardConfig;
  checkpoint: CheckpointInfo | null;
  modifiedFiles: string[];
  trippedFiles: string[];
  limitState: 'ok' | 'warn' | 'hard-stop';
  events: WatchActivityEvent[];
  processes: MonitoredProcess[];
  timestamp: number;
}

export interface PanicResult {
  restoredFiles: string[];
  restoredCount: number;
  skippedFiles: string[];
  killedPids: number[];
}

export type KillResult = { ok: true; pid: number } | { ok: false; pid: number; error: string };
export type ModeResult = { ok: true; config: GuardConfig } | { ok: false; error: string };

const MAX_SNAPSHOT_EVENTS = 80;
const MAX_SESSION_EVENTS = 200;
/** State changes are coalesced so that an edit burst does not turn into a broadcast storm. */
const UPDATE_COALESCE_MS = 80;

/**
 * The single place where watcher, process monitor and config meet.
 *
 * Every front end (web dashboard, terminal UI, plain log output) reads state through
 * `getSnapshot()` and acts through the methods below, so all of them show and do the same thing.
 *
 * Events:
 * - `event`  (WatchActivityEvent): one entry was added to the activity log
 * - `update` (StatusSnapshot): state changed; coalesced to at most one per 80 ms
 */
export class WatchdogSession extends EventEmitter {
  public readonly rootDir: string;
  public readonly configManager: GuardConfigManager;
  public readonly watcher: RepoWatcher;
  public readonly processMonitor: ProcessMonitor;

  private sessionEvents: WatchActivityEvent[] = [];
  private counters: Partial<Record<WatchEventType, number>> = {};
  private updateTimer: NodeJS.Timeout | null = null;
  private scanErrorReported = false;
  private eventSeq = 0;
  private disposers: Array<() => void> = [];

  constructor(deps: WatchdogSessionDeps) {
    super();
    this.rootDir = deps.rootDir;
    this.configManager = deps.configManager;
    this.watcher = deps.watcher;
    this.processMonitor = deps.processMonitor;

    this.listen(this.watcher, 'file-edit', () => {
      this.processMonitor.recordFileActivity();
    });

    this.listen(this.watcher, 'activity', (event: WatchActivityEvent) => {
      this.count(event);
      this.emit('event', event);
      this.scheduleUpdate();
    });

    this.listen(this.processMonitor, 'process-frozen', (proc: MonitoredProcess) => {
      this.addEvent({
        type: 'process-alert',
        message: `${proc.status}: PID ${proc.pid} (${proc.cmd}, ${proc.memoryMb} MB) — ${proc.reason}`,
        severity: proc.status === 'FROZEN' ? 'critical' : 'warn',
      });
    });

    this.listen(this.processMonitor, 'process-killed', (info: ProcessKilledEvent) => {
      const what = info.process ? ` (${info.process.cmd})` : '';
      this.addEvent({
        type: 'process-killed',
        message: info.escalated
          ? `PID ${info.pid}${what} did not exit after SIGTERM — sent SIGKILL`
          : `Sent ${info.signal} to PID ${info.pid}${what}`,
        severity: 'warn',
      });
    });

    this.listen(this.processMonitor, 'scan-complete', () => {
      this.scanErrorReported = false;
      this.scheduleUpdate();
    });

    this.listen(this.processMonitor, 'scan-error', (err: unknown) => {
      if (this.scanErrorReported) return;
      this.scanErrorReported = true;
      this.addEvent({
        type: 'watch-error',
        message: `Process scan failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warn',
      });
    });
  }

  public getSnapshot(): StatusSnapshot {
    const config = this.configManager.getConfig();
    const modifiedFiles = this.watcher.getModifiedFiles();
    const events = [...this.sessionEvents, ...this.watcher.getRecentEvents(MAX_SNAPSHOT_EVENTS)]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_SNAPSHOT_EVENTS);

    return {
      rootDir: this.rootDir,
      config,
      checkpoint: this.watcher.getCheckpoint(),
      modifiedFiles,
      trippedFiles: this.watcher.loopDetector.getTrippedFiles(),
      limitState: this.configManager.evaluateFileLimit(modifiedFiles.length),
      events,
      processes: this.processMonitor.getProcesses(),
      timestamp: Date.now(),
    };
  }

  /** How many events of each type this session has seen (not capped like the event list). */
  public getCounters(): Partial<Record<WatchEventType, number>> {
    return { ...this.counters };
  }

  /** Switches the guard mode. Unknown modes are rejected instead of silently becoming "balanced". */
  public setMode(rawMode: unknown): ModeResult {
    const mode = parseMode(rawMode);
    if (!mode) {
      return { ok: false, error: 'Unknown mode, expected strict | balanced | yolo' };
    }
    const updated = this.configManager.setMode(mode, true);
    this.processMonitor.setSilenceTimeoutSec(updated.limits.mcpSilenceTimeoutSec);
    this.watcher.loopDetector.setMaxEditsPerFilePerMinute(updated.limits.maxEditsPerFilePerMinute);
    this.addEvent({
      type: 'mode-change',
      message: `Guard mode switched to ${updated.mode.toUpperCase()}`,
      severity: 'info',
    });
    return { ok: true, config: updated };
  }

  /** Rolls one file back to the session checkpoint and re-arms the circuit breaker for it. */
  public rollbackFile(filePath: string): boolean {
    const restored = this.watcher.rollbackFile(filePath);
    if (restored) {
      this.watcher.loopDetector.resetFile(filePath);
    }
    this.scheduleUpdate();
    return restored;
  }

  /** Terminates one process from the monitored list (SIGTERM, then SIGKILL after the grace period). */
  public killProcess(pid: number): KillResult {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, pid, error: 'Invalid PID' };
    }
    if (!this.processMonitor.isTracked(pid)) {
      return { ok: false, pid, error: 'PID is not a monitored agent or MCP process' };
    }
    const killed = this.processMonitor.killProcess(pid);
    this.scheduleUpdate();
    return killed
      ? { ok: true, pid }
      : { ok: false, pid, error: 'Signal could not be delivered (already gone or not permitted)' };
  }

  /** Terminates everything currently classified as stale or frozen. */
  public killStale(): number[] {
    const killed = this.processMonitor.killAllMonitored(true);
    this.scheduleUpdate();
    return killed;
  }

  public getStaleProcesses(): MonitoredProcess[] {
    return this.processMonitor
      .getProcesses()
      .filter((p) => p.status === 'FROZEN' || p.status === 'STALE' || p.safety === 'safe-to-kill');
  }

  /**
   * Emergency brake: stops the agent and tool processes of the watched repository right away
   * (SIGKILL, no grace period) and restores every changed file to the session checkpoint.
   * Sessions in other repositories are not touched.
   */
  public panic(): PanicResult {
    const killedPids = this.processMonitor.killInWatchedRepo('SIGKILL');
    const rollback = this.watcher.panicRollbackAll();
    this.scheduleUpdate();
    return {
      restoredFiles: rollback.restoredFiles,
      restoredCount: rollback.count,
      skippedFiles: rollback.skippedFiles,
      killedPids,
    };
  }

  /** Adds an entry to the activity log that does not come from the file watcher. */
  public addEvent(partial: Pick<WatchActivityEvent, 'type' | 'message' | 'severity'>): WatchActivityEvent {
    this.eventSeq += 1;
    const event: WatchActivityEvent = {
      id: `ses-${Date.now()}-${this.eventSeq}`,
      timestamp: Date.now(),
      ...partial,
    };
    this.sessionEvents.unshift(event);
    if (this.sessionEvents.length > MAX_SESSION_EVENTS) {
      this.sessionEvents.length = MAX_SESSION_EVENTS;
    }
    this.count(event);
    this.emit('event', event);
    this.scheduleUpdate();
    return event;
  }

  /** Detaches from watcher and monitor. The session must not be used afterwards. */
  public dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    for (const off of this.disposers) off();
    this.disposers = [];
    this.removeAllListeners();
  }

  private count(event: WatchActivityEvent): void {
    this.counters[event.type] = (this.counters[event.type] ?? 0) + 1;
  }

  private listen(
    emitter: EventEmitter,
    eventName: string,
    handler: (...args: never[]) => void,
  ): void {
    const fn = handler as (...args: unknown[]) => void;
    emitter.on(eventName, fn);
    this.disposers.push(() => emitter.off(eventName, fn));
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (this.listenerCount('update') > 0) {
        this.emit('update', this.getSnapshot());
      }
    }, UPDATE_COALESCE_MS);
    this.updateTimer.unref();
  }
}
