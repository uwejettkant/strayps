import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import {
  CONFIG_FILENAME,
  type ConfigReloadResult,
  type StraypsConfig,
  ConfigManager,
} from './config.js';
import type { ActivityEvent, ActivityEventType } from './events.js';
import { ProcessMonitor } from './process-monitor.js';
import { homeDirectory } from './processes/cwd.js';
import { formatMemory } from './processes/memory.js';
import type { MonitoredProcess, PauseTarget, ProcessKilledEvent } from './processes/types.js';

export interface MonitorSessionDeps {
  /** The current repository: its agents are the ones `pause` holds and the list marks as "this repo". */
  rootDir: string;
  configManager: ConfigManager;
  processMonitor: ProcessMonitor;
}

/** One consistent view of the monitor state. The dashboard and the terminal UI both render this. */
export interface StatusSnapshot {
  rootDir: string;
  config: StraypsConfig;
  events: ActivityEvent[];
  processes: MonitoredProcess[];
  timestamp: number;
}

export interface PauseResult {
  /** PIDs that were held or continued. */
  pids: number[];
  /** pause: confirmed, but gone or another process under the PID now; not held. */
  gone?: number[];
  /** pause: targets the confirmation did not show and that are not held: a new agent and what it runs. */
  notAsked?: number[];
  /** pause: what the confirmed agents started while the question was open; held too (also in `pids`). */
  alsoHeld?: number[];
}

/**
 * One process a person confirmed for ending, as it was shown: PID and the time strayps first
 * saw it. A PID that exited and was reused by another process while the question was open has a
 * different `firstSeenAt` and is not ended.
 */
export interface KillConfirmation {
  pid: number;
  firstSeenAt: number;
}

export type KillResult =
  | {
      ok: true;
      pid: number;
      /** False when the named process had already exited, so only its session was signalled. */
      targetSignalled?: boolean;
      /** Processes of the agent's session that were confirmed and signalled with it. */
      alsoEnded?: number[];
      /** Processes of the session that were not in the confirmation: left alone. */
      leftRunning?: number[];
      /** Confirmed processes that had exited or no longer belong to the session: nothing sent. */
      notFound?: number[];
      /** Confirmed processes of the session whose signal could not be delivered. */
      failed?: number[];
    }
  | { ok: false; pid: number; error: string };

/** How a kill was confirmed: the process as it was shown, and for an agent its session. */
export interface KillOptions {
  /** `firstSeenAt` of the named process when the question was shown; a reused PID is refused. */
  firstSeenAt?: number;
  /** The processes of the agent's session the person confirmed. */
  also?: readonly KillConfirmation[];
}

/** What `kill` on a PID would end. For an agent: the monitored processes it started, too. */
export interface KillPlan {
  target: MonitoredProcess;
  /** Agents first, then the rest; each in the order of the process list. */
  alsoEnds: MonitoredProcess[];
}

const MAX_SNAPSHOT_EVENTS = 80;
const MAX_SESSION_EVENTS = 200;
/** State changes are coalesced so that an edit burst does not turn into a broadcast storm. */
const UPDATE_COALESCE_MS = 80;
/** Editors often write a file in several steps; reload once it has been quiet this long. */
const CONFIG_SETTLE_MS = 150;

/**
 * The single place where the process monitor and the config meet.
 *
 * Every front end (web dashboard, terminal UI, plain log output) reads state through
 * `getSnapshot()` and acts through the methods below, so all of them show and do the same thing.
 *
 * Events:
 * - `event`  (ActivityEvent): one entry was added to the activity log
 * - `update` (StatusSnapshot): state changed; coalesced to at most one per 80 ms
 */
export class MonitorSession extends EventEmitter {
  public readonly rootDir: string;
  public readonly configManager: ConfigManager;
  public readonly processMonitor: ProcessMonitor;

  private sessionEvents: ActivityEvent[] = [];
  private counters: Partial<Record<ActivityEventType, number>> = {};
  private updateTimer: NodeJS.Timeout | null = null;
  private scanErrorReported = false;
  private eventSeq = 0;
  private disposers: Array<() => void> = [];
  private configWatchPath: string | null = null;
  private configListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private lastConfigProblem: string | null = null;

  constructor(deps: MonitorSessionDeps) {
    super();
    this.rootDir = deps.rootDir;
    this.configManager = deps.configManager;
    this.processMonitor = deps.processMonitor;

    this.listen(this.processMonitor, 'process-frozen', (proc: MonitoredProcess) => {
      this.addEvent({
        type: 'process-alert',
        message: `${proc.status}: PID ${proc.pid} (${proc.cmd}, ${formatMemory(proc.memoryMb, proc.memorySource !== 'footprint')}) — ${proc.reason}`,
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

    this.listen(this.processMonitor, 'processes-paused', (pids: number[]) => {
      this.addEvent({
        type: 'process-paused',
        message: `Paused ${pids.length} process${pids.length === 1 ? '' : 'es'} of this repository's agents (PID ${pids.join(', ')}); resume continues them`,
        severity: 'warn',
      });
    });

    this.listen(this.processMonitor, 'processes-resumed', (pids: number[]) => {
      this.addEvent({
        type: 'process-resumed',
        message: `Resumed ${pids.length} process${pids.length === 1 ? '' : 'es'} (PID ${pids.join(', ')})`,
        severity: 'info',
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
        type: 'scan-error',
        message: `Process scan failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warn',
      });
    });
  }

  public getSnapshot(): StatusSnapshot {
    const config = this.configManager.getConfig();
    const processes = this.processMonitor.getProcesses();
    return {
      rootDir: this.rootDir,
      config,
      events: this.sessionEvents.slice(0, MAX_SNAPSHOT_EVENTS),
      processes,
      timestamp: Date.now(),
    };
  }

  /** How many events of each type this session has seen (not capped like the event list). */
  public getCounters(): Partial<Record<ActivityEventType, number>> {
    return { ...this.counters };
  }

  /**
   * Re-reads `.strayps.json` and applies it when it is valid. An invalid file changes nothing:
   * the previous settings stay and the activity log says why (once per distinct problem).
   */
  public reloadConfig(): ConfigReloadResult {
    const result = this.configManager.reload();
    if (!result.applied) {
      const problem = result.warnings.join('; ');
      if (problem !== this.lastConfigProblem) {
        this.lastConfigProblem = problem;
        this.addEvent({
          type: 'config-reload',
          message: `${CONFIG_FILENAME} changed but was not applied, previous settings kept: ${problem}`,
          severity: 'warn',
        });
      }
      return result;
    }

    if (result.changes.length > 0) {
      this.applyLimits(this.configManager.getConfig());
      // A warning, not an info line: the change alters what strayps does, and the agent being
      // watched can write this file as easily as the user can. It has to show up with --quiet too.
      this.addEvent({
        type: 'config-reload',
        message: `${CONFIG_FILENAME} reloaded: ${result.changes.join('; ')}`,
        severity: 'warn',
      });
    }
    const notice = result.warnings.join('; ');
    if (notice && notice !== this.lastConfigProblem) {
      this.addEvent({ type: 'config-reload', message: `${CONFIG_FILENAME}: ${notice}`, severity: 'warn' });
    }
    this.lastConfigProblem = notice || null;
    return result;
  }

  /**
   * Starts applying changes to `.strayps.json` while strayps runs (polling; works with
   * editors that save by replacing the file, and notices when the file is created or deleted).
   */
  public watchConfigFile(intervalMs: number = 500): void {
    if (this.configWatchPath) return;
    const filePath = this.configManager.configFilePath;
    this.configListener = (curr, prev) => {
      const unchanged =
        curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino;
      // A file that exists but is empty is being written right now; wait for the next change
      const beingWritten = curr.ino !== 0 && curr.size === 0;
      if (unchanged || beingWritten) return;
      if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = null;
        this.reloadConfig();
      }, CONFIG_SETTLE_MS);
      this.configReloadTimer.unref();
    };
    fs.watchFile(filePath, { interval: intervalMs, persistent: false }, this.configListener);
    this.configWatchPath = filePath;
  }

  public unwatchConfigFile(): void {
    if (this.configWatchPath && this.configListener) {
      fs.unwatchFile(this.configWatchPath, this.configListener);
    }
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = null;
    }
    this.configWatchPath = null;
    this.configListener = null;
  }

  /**
   * What `kill` would end, to show before it is confirmed. Ending only an agent left its MCP
   * servers behind as orphans, to be found and ended one by one; so for an agent the plan also
   * holds every monitored process it started, directly or through an agent it started. The tree
   * decides, never a status. An agent it started counts only when it works in the same directory,
   * and never when that directory is the home directory or `/`: an editor taken for an agent (one
   * that starts MCP servers and is not a known host) is often started there, and the sessions in
   * its terminals, in other repositories, must not end with it.
   */
  public getKillPlan(pid: number): KillPlan | null {
    return this.killPlanFrom(this.processMonitor.getProcesses(), pid);
  }

  private killPlanFrom(processes: MonitoredProcess[], pid: number): KillPlan | null {
    const target = processes.find((p) => p.pid === pid);
    if (!target) return null;
    if (target.category !== 'agent') return { target, alsoEnds: [] };
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    const home = homeDirectory();
    const sharedDirectory = (agent: MonitoredProcess): boolean =>
      Boolean(agent.cwd && agent.cwd === target.cwd && !['/', '~', home].includes(agent.cwd));
    const saysNothing = (dir: string | undefined): boolean => !dir || ['/', '~', home].includes(dir);
    const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
    // What an agent started in another directory is a session of its own: an agent strayps does not
    // recognize, started by this one in another repository, ended with it (review, 20.11.2026)
    const elsewhere = (proc: MonitoredProcess): boolean =>
      proc.category === 'child' && !saysNothing(proc.cwd) && !saysNothing(target.cwd) && !inside(proc.cwd!, target.cwd!);
    // Up the whole tree, not only the list: a walk over the list alone stopped at the first shell
    // or npx, and what ran below it in '/' ended with the session (external audit, 21.11.2026)
    const underElsewhere = (proc: MonitoredProcess): boolean => {
      let cur = this.processMonitor.parentOf(proc.pid) ?? proc.ppid;
      for (let depth = 0; cur !== undefined && cur > 1 && cur !== pid && depth < 64; depth++) {
        const listed = byPid.get(cur);
        if (listed && elsewhere(listed)) return true;
        cur = this.processMonitor.parentOf(cur);
      }
      return false;
    };
    const belongs = (proc: MonitoredProcess): boolean => {
      if (proc.category === 'agent' && !sharedDirectory(proc)) return false;
      if (elsewhere(proc) || underElsewhere(proc)) return false;
      let cur = proc.agentPid;
      for (let depth = 0; cur !== undefined && depth < 32; depth++) {
        if (cur === pid) return true;
        const agent = byPid.get(cur);
        if (!agent || !sharedDirectory(agent)) return false;
        cur = agent.agentPid;
      }
      return false;
    };
    const members = processes.filter((p) => p.pid !== pid && belongs(p));
    return {
      target,
      alsoEnds: [...members.filter((p) => p.category === 'agent'), ...members.filter((p) => p.category !== 'agent')],
    };
  }

  /**
   * Terminates one process from the monitored list (SIGTERM, then SIGKILL after the grace period).
   * With `firstSeenAt`, only if the PID still names the process that was shown. For an agent,
   * `also` holds the processes of its session the person confirmed, as they were shown: only those
   * that still belong to the session now, and are still the same process, end with it. Anything
   * else in the session was not confirmed and keeps running.
   */
  public killProcess(pid: number, options: KillOptions = {}): KillResult {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, pid, error: 'Invalid PID' };
    }
    const also = options.also;
    const confirmedSession = also !== undefined && also.length > 0;
    const current = this.processMonitor.getProcesses().find((p) => p.pid === pid);
    if (!current || !this.processMonitor.isTracked(pid)) {
      return {
        ok: false,
        pid,
        error: confirmedSession
          ? `PID ${pid} is no longer running, so nothing was ended; the processes it started are listed on their own now`
          : 'PID is not a monitored agent or MCP process',
      };
    }
    if (options.firstSeenAt !== undefined && current.firstSeenAt !== options.firstSeenAt) {
      return { ok: false, pid, error: `PID ${pid} now belongs to a different process than the one shown, so nothing was ended` };
    }
    const plan = confirmedSession ? this.getKillPlan(pid) : null;
    const killed = this.processMonitor.killProcess(pid);

    if (!plan) {
      this.scheduleUpdate();
      return killed
        ? { ok: true, pid }
        : { ok: false, pid, error: 'Nothing was sent: the process is gone, its PID belongs to another process now, or the signal was not permitted' };
    }

    const confirmed = new Map(also!.map((c) => [c.pid, c.firstSeenAt]));
    const alsoEnded: number[] = [];
    const leftRunning: number[] = [];
    const failed: number[] = [];
    const inPlan = new Set<number>();
    for (const proc of plan.alsoEnds) {
      inPlan.add(proc.pid);
      if (confirmed.get(proc.pid) !== proc.firstSeenAt) leftRunning.push(proc.pid);
      else if (this.processMonitor.killProcess(proc.pid)) alsoEnded.push(proc.pid);
      else failed.push(proc.pid);
    }
    const notFound = also!.map((c) => c.pid).filter((p) => !inPlan.has(p));
    if (leftRunning.length > 0) {
      const one = leftRunning.length === 1;
      this.addEvent({
        type: 'process-alert',
        message: `PID ${leftRunning.join(', ')} ${one ? 'belongs' : 'belong'} to the session of PID ${pid} but ${one ? 'was' : 'were'} not in the confirmation, so ${one ? 'it keeps' : 'they keep'} running`,
        severity: 'warn',
      });
    }
    this.scheduleUpdate();
    if (!killed && alsoEnded.length === 0) {
      return { ok: false, pid, error: 'Nothing was sent: the process is gone, its PID belongs to another process now, or the signal was not permitted' };
    }
    return { ok: true, pid, targetSignalled: killed, alsoEnded, leftRunning, notFound, failed };
  }

  /**
   * The processes `pause` would hold right now, to show before it is confirmed: the listed pause
   * targets and what the agents run beyond the list (a shell around a tool call, a young call).
   */
  public getPauseTargets(): PauseTarget[] {
    return this.processMonitor.getPauseTargets();
  }

  /**
   * Holds the coding agents of the current repository and the processes they started (SIGSTOP).
   * Nothing is terminated; `resume` continues them where they stopped. Dev servers, editors and
   * sessions in other repositories are not touched. With `confirmed` (what a person was shown),
   * those, each still the same process, and what those agents started while the question was
   * open, never a new agent; without it, every current target and what they started since.
   */
  public pause(confirmed?: PauseTarget[]): PauseResult {
    const outcome = this.processMonitor.pauseTargets(confirmed);
    this.scheduleUpdate();
    return outcome;
  }

  /** Continues every process `pause` is holding. */
  public resume(): PauseResult {
    const pids = this.processMonitor.resumePaused();
    this.scheduleUpdate();
    return { pids };
  }

  /** Adds an entry to the activity log. */
  public addEvent(partial: Pick<ActivityEvent, 'type' | 'message' | 'severity'>): ActivityEvent {
    this.eventSeq += 1;
    const event: ActivityEvent = {
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

  /** Detaches from the monitor and the config file. The session must not be used afterwards. */
  public dispose(): void {
    this.unwatchConfigFile();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    for (const off of this.disposers) off();
    this.disposers = [];
    this.removeAllListeners();
  }

  /** Pushes limits that live outside the config manager into the parts that use them. */
  private applyLimits(config: StraypsConfig): void {
    this.processMonitor.setSilenceTimeoutSec(config.limits.mcpSilenceTimeoutSec);
    this.processMonitor.setStaleSessionHours(config.limits.staleSessionHours);
    this.processMonitor.setAgentNames(config.agents);
  }

  private count(event: ActivityEvent): void {
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
