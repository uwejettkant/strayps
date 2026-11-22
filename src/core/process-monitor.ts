import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { classifyStatus, STALE_QUIET_SEC } from './processes/classify.js';
import { formatReadableCmd } from './processes/command-line.js';
import { homeDirectory, resolveProcessCwds } from './processes/cwd.js';
import { MEMORY_READ_INTERVAL_MS, readFootprints } from './processes/memory.js';
import { programNames } from './processes/program-names.js';
import {
  detectHost,
  findMcpClient,
  hostOnTheWay,
  IGNORED_SYSTEM_PATTERNS,
  isAppOrTerminal,
  LAUNCHER_NAMES,
  recognizeProcess,
} from './processes/recognition.js';
import {
  defaultProcessAge,
  defaultProcessAges,
  defaultProcessAlive,
  defaultProcessKiller,
  defaultProcessLister,
  defaultProcessTree,
  parseElapsedTime,
} from './processes/system.js';
import { ProcessTree } from './processes/tree.js';
import type {
  AgentDetection,
  MemorySource,
  MonitoredProcess,
  PauseOutcome,
  PauseTarget,
  ProcessCategory,
  ProcessHealthStatus,
  ProcessKilledEvent,
  RawProcessInfo,
} from './processes/types.js';

export interface ProcessMonitorOptions {
  rootDir?: string;
  pollIntervalMs?: number;
  mcpSilenceTimeoutSec?: number;
  /** Window for measured inactivity before STALE (default STALE_QUIET_SEC); tests use 0. */
  staleQuietSec?: number;
  staleSessionHours?: number;
  agentActive?: boolean;
  selfPid?: number;
  processLister?: () => Promise<RawProcessInfo[]>;
  processKiller?: (pid: number, signal?: NodeJS.Signals) => boolean;
  /**
   * Resolves working directories for PIDs. Defaults to `/proc` (Linux) or `lsof` (macOS) with the
   * built-in lister, and to "unknown" when a custom `processLister` is supplied.
   */
  cwdResolver?: (pids: number[]) => Promise<Map<number, string>>;
  /**
   * Liveness check used to escalate from SIGTERM to SIGKILL. Defaults to `process.kill(pid, 0)` with
   * the built-in killer, and to "already gone" when a custom `processKiller` is supplied.
   */
  processAlive?: (pid: number) => boolean;
  /**
   * Seconds since the process with this PID started, or undefined if unknown. Before SIGKILL the
   * monitor checks that the PID still names the process it sent SIGTERM to. Defaults to `ps` with
   * the built-in killer, and to "unknown" when a custom `processKiller` is supplied.
   */
  processAge?: (pid: number) => number | undefined;
  /**
   * Seconds since each of these processes started, read right before pause holds them; a PID
   * missing from the result is unknown. Defaults to one `ps` call with the built-in killer, and to
   * "unknown" when a custom `processKiller` is supplied.
   */
  processAges?: (pids: number[]) => Map<number, number>;
  /**
   * The whole process table, read right after pause has held the agents, to find what they started
   * while the question was open; undefined when it cannot be read, and pause then uses the last
   * scan. Defaults to `ps` with the built-in killer, and to undefined when a custom
   * `processKiller` is supplied.
   */
  processTree?: () => RawProcessInfo[] | undefined;
  /** Time a process gets to exit after SIGTERM before SIGKILL is sent (default 3000 ms, 0 disables). */
  killGraceMs?: number;
  /** More program names to treat as coding agents (the `agents` setting); matched exactly. */
  agentNames?: string[];
  /**
   * Physical footprint in bytes per PID. Defaults to macOS `footprint` with the built-in lister, and
   * to none when a custom `processLister` is supplied: its PIDs are not real ones (tests, demo).
   * Without a value for a PID its RSS is shown, marked as approximate.
   */
  memoryReader?: (pids: number[]) => Promise<Map<number, number>>;
  /**
   * Monotonic clock in milliseconds for process-age checks and pause budgets, so system wall-clock
   * jumps (NTP, VM sync) never make a held process look replaced. Defaults to `performance.now`.
   */
  monotonicNow?: () => number;
}

/**
 * How old a process an agent started must be before it is listed. The shells, git and rg calls of
 * a tool call end within a second or two; listed, they would flicker through the table.
 */
const CHILD_MIN_AGE_SEC = 5;

/**
 * How often pause looks at the process table after it has held the agents. Each look can find a
 * process that a tool call forked after the look before; a held process forks nothing more.
 */
const PAUSE_LOOKS = 3;

/**
 * After this long, pause stops holding what it finds and only names it: the answer to the question
 * runs synchronously, and a slow `ps` would freeze the screen and delay signal handling.
 */
const PAUSE_LOOK_BUDGET_MS = 1500;

/** CPU time below this between two scans is measurement noise, not work. */
const CPU_TIME_TICK_SEC = 0.005;

/** Spacing of the CPU time samples kept per process for the window. */
const CPU_SAMPLE_SPACING_MS = 30_000;

/** A process a scan lists, and why. */
interface Candidate {
  raw: RawProcessInfo;
  category: ProcessCategory;
  detectedBy?: AgentDetection;
}

/** What a scan lists, in the order it found it. */
interface Candidates {
  list: Candidate[];
  byPid: Map<number, Candidate>;
}

/** What one scan knows beyond a single process, built once per scan. */
interface ScanContext {
  now: number;
  /** Monotonic time when `ps` read the ages of this scan. */
  listedAt: number;
  tree: ProcessTree;
  selfAncestors: Set<number>;
  candidateByPid: Map<number, Candidate>;
  descendantsOf: Map<number, number[]>;
  cwdMap: Map<number, string>;
  homeDir: string;
  /** PIDs whose own working directory lies in the watched repository. */
  repoPids: Set<number>;
  /** True for a PID pause held after this scan read its list. */
  heldAfterList: (pid: number) => boolean;
}

export class ProcessMonitor extends EventEmitter {
  private rootDir: string;
  private pollIntervalMs: number;
  private mcpSilenceTimeoutSec: number;
  private staleSessionSec: number;
  private staleQuietSec: number;
  private agentActive: boolean;
  private selfPid: number;
  private killGraceMs: number;
  private processLister: () => Promise<RawProcessInfo[]>;
  private processKiller: (pid: number, signal?: NodeJS.Signals) => boolean;
  private processAlive: (pid: number) => boolean;
  private processAge: (pid: number) => number | undefined;
  private processAges: (pids: number[]) => Map<number, number>;
  private processTree: () => RawProcessInfo[] | undefined;
  private cwdResolver: (pids: number[]) => Promise<Map<number, string>>;
  private monotonicNow: () => number;
  private agentNames: Set<string> = new Set();

  private timer: NodeJS.Timeout | null = null;
  private tracked: Map<number, MonitoredProcess> = new Map();
  private paused: Set<number> = new Set();
  /** For each held PID: its age and the monotonic time when it was measured, to tell a reused PID. */
  private heldSince: Map<number, { elapsedSec: number; at: number }> = new Map();
  /** Counts every SIGSTOP; per held PID the count at its hold, to tell holds newer than a scan's list. */
  private holdCount = 0;
  private holdNumber: Map<number, number> = new Map();
  /** Unlisted processes the agents of this repository run, as of the last scan (see PauseTarget). */
  private pauseExtras: Map<number, { raw: RawProcessInfo; elapsedSec?: number; startedAt?: number }> = new Map();
  /**
   * Every process the last finished scan saw, listed or not (shells and npx are not listed), and
   * its monotonic time: what pause falls back to, and where `parentOf` looks.
   */
  private lastScan: { at: number; tree: ProcessTree } = { at: 0, tree: new ProcessTree([]) };
  /** Ancestors of strayps (wrappers, shell, launching agent) as of the last scan; never held. */
  private lastSelfAncestors: Set<number> = new Set();
  private alertedPids: Set<number> = new Set();
  /** CPU time samples per PID, oldest first, spaced CPU_SAMPLE_SPACING_MS apart. */
  private cpuSamples: Map<number, Array<{ at: number; cpuTimeSec: number }>> = new Map();
  private exitHookInstalled = false;
  /** Per monitored process: the descendants seen so far and when a new one last appeared. */
  private children: Map<number, { known: Set<number>; lastNewAt?: number }> = new Map();
  private readonly continueOnExit = (): void => {
    this.resumePaused();
  };
  private scanInFlight: Promise<MonitoredProcess[]> | null = null;
  private memoryReader: ((pids: number[]) => Promise<Map<number, number>>) | undefined;
  /** Footprint in bytes per PID from the last read, for processes still listed. */
  private footprints: Map<number, number> = new Map();
  private lastMemoryReadAt = -Infinity;
  /** PIDs that received SIGTERM and are inside their grace period. */
  private terminating: Map<number, { timer: NodeJS.Timeout; process: MonitoredProcess; sentAt: number }> = new Map();

  constructor(options: ProcessMonitorOptions = {}) {
    super();
    const resolvedRoot = path.resolve(options.rootDir ?? process.cwd());
    try {
      // The real path, as lsof reports working directories (e.g. /tmp -> /private/tmp on macOS)
      this.rootDir = fs.realpathSync(resolvedRoot);
    } catch {
      this.rootDir = resolvedRoot;
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.mcpSilenceTimeoutSec = options.mcpSilenceTimeoutSec ?? 45;
    this.staleSessionSec = (options.staleSessionHours ?? 6) * 3600;
    this.staleQuietSec = options.staleQuietSec ?? STALE_QUIET_SEC;
    this.agentActive = options.agentActive ?? true;
    this.selfPid = options.selfPid ?? process.pid;
    this.killGraceMs = options.killGraceMs ?? 3000;
    this.processLister = options.processLister ?? defaultProcessLister;
    this.processKiller = options.processKiller ?? defaultProcessKiller;
    this.processAlive =
      options.processAlive ?? (options.processKiller ? () => false : defaultProcessAlive);
    this.processAge = options.processAge ?? (options.processKiller ? () => undefined : defaultProcessAge);
    this.processAges = options.processAges ?? (options.processKiller ? () => new Map() : defaultProcessAges);
    this.processTree = options.processTree ?? (options.processKiller ? () => undefined : defaultProcessTree);
    this.cwdResolver =
      options.cwdResolver ??
      (options.processLister ? async () => new Map<number, string>() : resolveProcessCwds);
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.memoryReader =
      options.memoryReader ??
      (options.processLister || process.platform !== 'darwin' ? undefined : readFootprints);
    this.setAgentNames(options.agentNames ?? []);
  }

  public start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
  }

  /**
   * Stops polling. Processes still inside their SIGTERM grace period are checked one last time,
   * so that quitting right after a kill does not leave a process behind that ignores SIGTERM.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Never leave an agent held when strayps goes away
    this.resumePaused();
    for (const pid of Array.from(this.terminating.keys())) {
      this.escalateKill(pid);
    }
  }

  public setSilenceTimeoutSec(seconds: number): void {
    if (seconds > 0) {
      this.mcpSilenceTimeoutSec = seconds;
    }
  }

  public getSilenceTimeoutSec(): number {
    return this.mcpSilenceTimeoutSec;
  }

  /** Age after which a session in another repository counts as stale. */
  public setStaleSessionHours(hours: number): void {
    if (hours > 0) {
      this.staleSessionSec = hours * 3600;
    }
  }

  public getStaleSessionHours(): number {
    return this.staleSessionSec / 3600;
  }

  /** Program names from the `agents` setting; replaces the previous list. */
  public setAgentNames(names: readonly string[]): void {
    this.agentNames = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  }

  public getAgentNames(): string[] {
    return Array.from(this.agentNames);
  }

  public setAgentActive(active: boolean): void {
    this.agentActive = active;
  }

  public isAgentActive(): boolean {
    return this.agentActive;
  }

  /**
   * Performs a single scan of running processes and updates inactivity timers,
   * real RAM usage (MB), uptime, classification and pause targets.
   * Overlapping calls share the scan that is already running.
   */
  public scan(now: number = Date.now()): Promise<MonitoredProcess[]> {
    if (this.scanInFlight) {
      return this.scanInFlight;
    }
    this.scanInFlight = this.performScan(now)
      .catch((err: unknown) => {
        this.emit('scan-error', err);
        return this.getProcesses();
      })
      .finally(() => {
        this.scanInFlight = null;
      });
    return this.scanInFlight;
  }

  /**
   * One scan, in phases: read the table; find what to list; read working directories and memory;
   * observe each listed process; forget what is gone; note what pause would hold beyond the list.
   * The three awaits are where pause can run in between: a hold made then is newer than this list.
   */
  private async performScan(now: number): Promise<MonitoredProcess[]> {
    // pause can answer while this scan waits for lsof or footprint, and hold processes this list
    // does not have yet: they must not be forgotten when the scan goes on (safety review, 22.11.2026)
    const holdsBeforeList = this.holdCount;
    const heldAfterList = (pid: number): boolean => (this.holdNumber.get(pid) ?? 0) > holdsBeforeList;
    const rawList = await this.processLister();
    // Monotonic clock when ps had read the ages: Linux ps measures etime monotonically, so a wall
    // clock jump (NTP, VM sync) must never make a held process look replaced and stay stopped.
    // Reading after processLister also keeps a slow ps on the safe side (safety review, 22.11.2026).
    const listedAt = this.monotonicNow();
    const tree = new ProcessTree(rawList);
    // The chain of processes that launched strayps (npm, tsx, npx wrappers, the shell).
    const selfAncestors = new Set(tree.ancestors(this.selfPid));

    const candidates = this.listedByOwnCommandLine(tree, selfAncestors);
    this.addMcpClients(tree, candidates);
    this.addWhatAgentsStarted(tree, candidates, selfAncestors, listedAt, heldAfterList);
    const pids = candidates.list.map((c) => c.raw.pid);

    const cwdMap = await this.cwdResolver(pids);

    // A value of a PID that is not listed any more must not end up on a new process with that PID
    for (const pid of this.footprints.keys()) {
      if (!candidates.byPid.has(pid)) this.footprints.delete(pid);
    }
    if (this.memoryReader && now - this.lastMemoryReadAt >= MEMORY_READ_INTERVAL_MS) {
      this.lastMemoryReadAt = now;
      try {
        this.footprints = await this.memoryReader(pids);
      } catch (err) {
        // No footprint tool on this system: RSS from now on. Any other failure: RSS until the next read.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.memoryReader = undefined;
        this.footprints = new Map();
      }
    }

    const scan: ScanContext = {
      now,
      listedAt,
      tree,
      selfAncestors,
      candidateByPid: candidates.byPid,
      descendantsOf: this.descendantsOf(tree, candidates.byPid),
      cwdMap,
      homeDir: homeDirectory(),
      repoPids: new Set(),
      heldAfterList,
    };
    // PIDs whose own working directory lies in the watched repository
    for (const { raw } of candidates.list) {
      if (this.isInsideRoot(raw.cwd ?? cwdMap.get(raw.pid))) scan.repoPids.add(raw.pid);
    }

    const seenPids = new Set<number>();
    for (const candidate of candidates.list) {
      // Ended while this scan waited for working directories or memory: it must not come back
      // with a new firstSeenAt, to be ended a second time (review, 20.11.2026)
      if (this.terminating.has(candidate.raw.pid)) continue;
      seenPids.add(candidate.raw.pid);
      const monitored = this.observe(candidate, scan);
      this.tracked.set(monitored.pid, monitored);
      this.reportStatusChange(monitored);
    }

    this.forgetWhatIsGone(seenPids, tree, heldAfterList);
    this.pauseExtras = this.unlistedPauseTargets(tree, selfAncestors, listedAt);
    // With the list it belongs to: set while a scan waits, it paired a new tree with the old list
    this.lastScan = { at: listedAt, tree };
    this.lastSelfAncestors = selfAncestors;

    const processes = this.getProcesses();
    this.emit('scan-complete', processes);
    return processes;
  }

  /** Coding agents and MCP servers, recognized by their own command line. */
  private listedByOwnCommandLine(tree: ProcessTree, selfAncestors: Set<number>): Candidates {
    const list: Candidate[] = [];
    for (const raw of tree.raws) {
      if (raw.pid === this.selfPid) continue;
      if (this.terminating.has(raw.pid)) continue;
      const cmdLower = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      // Skip `npm exec` wrapper parents when their actual node child process is running
      if (cmdLower.includes('npm exec ') && tree.hasChildren(raw.pid)) {
        continue;
      }
      const recognized = recognizeProcess(raw, this.agentNames);
      if (!recognized) continue;
      // Wrappers that started strayps itself are not agent work; killing them would kill us.
      if (selfAncestors.has(raw.pid) && recognized.category !== 'agent') continue;
      list.push({ raw, ...recognized });
    }
    return { list, byPid: new Map(list.map((c) => [c.raw.pid, c])) };
  }

  /**
   * Every MCP server is started by a client. A client that is not an editor, a desktop app or a
   * terminal is a coding agent, whatever it is called, so no list of agent products is needed.
   */
  private addMcpClients(tree: ProcessTree, candidates: Candidates): void {
    for (const server of candidates.list.filter((c) => c.category === 'mcp')) {
      const clientPid = findMcpClient(server.raw, tree, (pid) => candidates.byPid.get(pid)?.category);
      if (clientPid === undefined || clientPid === this.selfPid || this.terminating.has(clientPid)) {
        continue;
      }
      const known = candidates.byPid.get(clientPid);
      if (known) {
        if (known.category !== 'agent') {
          known.category = 'agent';
          known.detectedBy = 'mcp-client';
        }
        continue;
      }
      const client: Candidate = { raw: tree.get(clientPid)!, category: 'agent', detectedBy: 'mcp-client' };
      candidates.list.push(client);
      candidates.byPid.set(clientPid, client);
    }
  }

  /**
   * What an agent started and is still running: a dev server, a test watcher, a browser its MCP
   * server opened. Decided by the process tree alone: "node", "chromium" or "playwright" in a
   * command line listed the user's own servers and apps as well (cut on 20.11.2026). Also every
   * process strayps holds, wherever it is in the tree now.
   */
  private addWhatAgentsStarted(
    tree: ProcessTree,
    candidates: Candidates,
    selfAncestors: Set<number>,
    listedAt: number,
    heldAfterList: (pid: number) => boolean,
  ): void {
    const agentAbove = (pid: number): boolean => {
      for (const cur of tree.ancestors(pid)) {
        // its own subtree: what it runs is no work of the agent that started it
        if (cur === this.selfPid) return false;
        if (candidates.byPid.get(cur)?.category === 'agent') return true;
      }
      return false;
    };
    for (const raw of tree.raws) {
      if (candidates.byPid.has(raw.pid) || raw.pid === this.selfPid || this.terminating.has(raw.pid)) continue;
      // The wrappers that started strayps: ending the agent's session must not end strayps
      if (selfAncestors.has(raw.pid)) continue;
      // A held process stays in view until it is continued or gone, wherever it is in the tree now:
      // a held browser whose MCP server was ended moved to PID 1, left the list and the set of held
      // processes, and stayed stopped for good (review, 20.11.2026)
      if (this.stillHeld(raw, listedAt, heldAfterList(raw.pid))) {
        const held: Candidate = { raw, category: this.tracked.get(raw.pid)?.category ?? 'child' };
        candidates.list.push(held);
        candidates.byPid.set(raw.pid, held);
        continue;
      }
      if (!agentAbove(raw.pid)) continue;
      // Without a known age a tool call cannot be told from a server
      if (raw.etime === undefined || parseElapsedTime(raw.etime).elapsedSec < CHILD_MIN_AGE_SEC) continue;
      const text = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      if (IGNORED_SYSTEM_PATTERNS.some((pattern) => text.includes(pattern))) continue;
      // A shell or npm with a process under it only wraps that process
      if (tree.hasChildren(raw.pid) && programNames(raw).some((name) => LAUNCHER_NAMES.has(name))) {
        continue;
      }
      const child: Candidate = { raw, category: 'child' };
      candidates.list.push(child);
      candidates.byPid.set(raw.pid, child);
    }
  }

  /**
   * Descendants of every listed process, for "did it start a process?". strayps's own subtree is
   * left out: its ps calls would make the agent that started it look busy forever.
   */
  private descendantsOf(tree: ProcessTree, listed: Map<number, Candidate>): Map<number, number[]> {
    const descendantsOf = new Map<number, number[]>();
    for (const r of tree.raws) {
      if (r.pid === this.selfPid) continue;
      const chain = tree.ancestors(r.pid);
      if (chain.includes(this.selfPid)) continue;
      for (const ancestor of chain) {
        if (!listed.has(ancestor)) continue;
        const list = descendantsOf.get(ancestor);
        if (list) list.push(r.pid);
        else descendantsOf.set(ancestor, [r.pid]);
      }
    }
    return descendantsOf;
  }

  private isInsideRoot(cwd: string | undefined): boolean {
    if (typeof cwd !== 'string' || cwd.length === 0) return false;
    const resolved = path.resolve(cwd);
    return resolved === this.rootDir || resolved.startsWith(this.rootDir + path.sep);
  }

  /** One listed process as this scan sees it: measured, placed, classified, and whether pause holds it. */
  private observe({ raw, category, detectedBy }: Candidate, scan: ScanContext): MonitoredProcess {
    const { now, listedAt, tree, selfAncestors } = scan;
    const activity = this.measure(raw, now, scan.descendantsOf.get(raw.pid) ?? []);
    const { silenceSec } = activity;
    const { elapsedSec, formattedUptime } = raw.etime
      ? parseElapsedTime(raw.etime)
      : { elapsedSec: silenceSec, formattedUptime: `${silenceSec}s` };

    const rawCwd = raw.cwd ?? scan.cwdMap.get(raw.pid);
    const homeDir = scan.homeDir;
    // Only the home directory and what is inside it: /Users/uj-backup is not ~-backup
    const displayCwd = rawCwd
      ? homeDir.length > 1 && (rawCwd === homeDir || rawCwd.startsWith(`${homeDir}/`))
        ? `~${rawCwd.slice(homeDir.length)}`
        : rawCwd
      : undefined;

    const hasRepoAncestor = (pid: number): boolean => tree.ancestors(pid).some((cur) => scan.repoPids.has(cur));
    // A tool process started by an agent of the watched repo belongs to that session,
    // wherever its own working directory is (many MCP servers run in "/" or their install dir).
    const belongsToWatchedRepo = this.isInsideRoot(rawCwd) || hasRepoAncestor(raw.pid);

    const host = detectHost(raw, tree);

    // Check whether this process (or its parent wrapper) has a living parent agent
    const grandparent = raw.ppid ? tree.parentOf(raw.ppid) : undefined;
    const hasLiveParentChain = Boolean(
      raw.ppid && tree.has(raw.ppid) && (!grandparent || grandparent === 1 || tree.has(grandparent)),
    );

    // Pause holds the agents of this repository and what they started, nothing else:
    // not a dev server from the user's terminal, not an editor, not another session, and never
    // the agent that started strayps itself (holding it freezes whatever owns strayps's terminal
    // or pipe and leaves no way to resume).
    const agentPid = tree.ancestors(raw.pid).find((cur) => scan.candidateByPid.get(cur)?.category === 'agent');
    const pauseTarget =
      belongsToWatchedRepo &&
      !selfAncestors.has(raw.pid) &&
      (category === 'agent' ||
        (agentPid !== undefined &&
          (scan.repoPids.has(agentPid) || hasRepoAncestor(agentPid)) &&
          !selfAncestors.has(agentPid) &&
          !hostOnTheWay(tree, raw.pid, agentPid)));
    const paused = this.stillHeld(raw, listedAt, scan.heldAfterList(raw.pid));

    const { status, reason } = classifyStatus(
      {
        pid: raw.pid,
        ppid: raw.ppid,
        pgid: raw.pgid,
        cmd: raw.cmd,
        category,
        detectedBy,
        cwd: rawCwd,
        displayCwd,
        belongsToWatchedRepo,
        host,
        hasLiveParentChain,
        elapsedSec,
        formattedUptime,
        hasCpuActivity: activity.hasCpuActivity,
        cpuTimeSec: activity.cpuTimeSec,
        usedInWindowSec: activity.usedInWindowSec,
        sinceNewChildMs: activity.lastNewChildAt === undefined ? undefined : now - activity.lastNewChildAt,
        silenceSec,
        paused,
      },
      {
        staleSessionSec: this.staleSessionSec,
        staleQuietSec: this.staleQuietSec,
        mcpSilenceTimeoutSec: this.mcpSilenceTimeoutSec,
        agentActive: this.agentActive,
      },
    );

    return {
      pid: raw.pid,
      ppid: raw.ppid,
      name: raw.name,
      cmd: formatReadableCmd(raw.name, raw.cmd ?? raw.name),
      cwd: displayCwd,
      category,
      cpu: activity.cpu,
      memory: activity.memory,
      memoryMb: activity.memoryMb,
      memorySource: activity.memorySource,
      uptime: formattedUptime,
      elapsedSec,
      startedAt: listedAt - elapsedSec * 1000,
      firstSeenAt: activity.existing?.firstSeenAt ?? now,
      lastActiveAt: activity.lastActiveAt,
      cpuTimeSec: activity.cpuTimeSec,
      silenceSec,
      status,
      reason,
      inWatchedRepo: belongsToWatchedRepo,
      pauseTarget,
      paused,
      host,
      ...(category === 'agent' ? { detectedBy: detectedBy ?? 'name' } : {}),
      agentPid,
    };
  }

  /**
   * What a listed process did since the last scan: memory, CPU time, new processes. The history
   * per PID starts over when the system gave the PID to a new process.
   */
  private measure(raw: RawProcessInfo, now: number, descendants: number[]) {
    const cpu = Number(raw.cpu ?? 0);
    const memory = Number(raw.memory ?? 0);

    // A PID the system handed to a new process since the last scan: the new one is younger than
    // the old one was. Its history (first seen, CPU samples) must not carry over, or a confirmation
    // given for the old process would match the new one.
    const previous = this.tracked.get(raw.pid);
    const reusedPid =
      previous !== undefined && raw.etime !== undefined && parseElapsedTime(raw.etime).elapsedSec + 2 < previous.elapsedSec;
    if (reusedPid) {
      this.cpuSamples.delete(raw.pid);
      // A footprint read in this scan is the new process's own; an older one is not
      if (this.lastMemoryReadAt !== now) this.footprints.delete(raw.pid);
    }

    const footprintBytes = this.footprints.get(raw.pid);
    const memorySource: MemorySource = footprintBytes !== undefined ? 'footprint' : 'rss';
    const memoryMb =
      footprintBytes !== undefined
        ? Number((footprintBytes / (1024 * 1024)).toFixed(1))
        : typeof raw.rssKb === 'number'
          ? Number((raw.rssKb / 1024).toFixed(1))
          : Number((memory * 16).toFixed(1));
    const existing = reusedPid ? undefined : previous;
    // Measured activity: did the process use CPU time since the last scan? `ps %cpu` is a
    // decaying average on macOS and the lifetime average on Linux, so it says little about now.
    // It is the fallback only for the first scan and for a lister without CPU time.
    const cpuTimeSec = raw.cpuTimeSec;
    const usedCpuSinceLastScan =
      cpuTimeSec !== undefined && existing?.cpuTimeSec !== undefined
        ? cpuTimeSec - existing.cpuTimeSec > CPU_TIME_TICK_SEC
        : undefined;
    const hasCpuActivity = usedCpuSinceLastScan ?? cpu > 0;
    // CPU time used over the last STALE_QUIET_SEC, as far as this monitor has seen it.
    // Undefined when the CPU time is unknown or the process has not been watched that long:
    // then there is no evidence of inactivity at all.
    const usedInWindowSec = this.cpuUsedInWindow(raw.pid, cpuTimeSec, now);
    const lastNewChildAt = this.trackChildren(raw.pid, descendants, now, reusedPid);
    const lastActiveAt = existing && !hasCpuActivity ? existing.lastActiveAt : now;
    const silenceSec = Math.max(0, Math.floor((now - lastActiveAt) / 1000));
    return {
      cpu,
      memory,
      memoryMb,
      memorySource,
      existing,
      cpuTimeSec,
      hasCpuActivity,
      usedInWindowSec,
      lastNewChildAt,
      lastActiveAt,
      silenceSec,
    };
  }

  /** Tells the front ends when a process turns STALE or FROZEN, and when it no longer is. */
  private reportStatusChange(monitored: MonitoredProcess): void {
    const { pid, status } = monitored;
    if ((status === 'FROZEN' || status === 'STALE') && !this.alertedPids.has(pid)) {
      this.alertedPids.add(pid);
      this.emit('process-frozen', monitored);
    } else if (status !== 'FROZEN' && status !== 'STALE' && this.alertedPids.has(pid)) {
      this.alertedPids.delete(pid);
      this.emit('process-recovered', monitored);
    }
  }

  /** Drops the history of what this scan no longer lists, and the holds of what is gone. */
  private forgetWhatIsGone(seenPids: Set<number>, tree: ProcessTree, heldAfterList: (pid: number) => boolean): void {
    for (const pid of Array.from(this.tracked.keys())) {
      if (!seenPids.has(pid)) {
        this.tracked.delete(pid);
        if (!heldAfterList(pid)) this.forgetHold(pid);
        this.alertedPids.delete(pid);
        this.cpuSamples.delete(pid);
        this.children.delete(pid);
      }
    }

    // Held PIDs that never made it into the list and are gone now
    for (const pid of Array.from(this.paused)) {
      if (!tree.has(pid) && !heldAfterList(pid)) this.forgetHold(pid);
    }
  }

  /**
   * What the agents of this repository run beyond the list: pause holds that too. Never strayps,
   * its wrappers or what it runs: holding those would stop the brake itself.
   */
  private unlistedPauseTargets(
    tree: ProcessTree,
    selfAncestors: Set<number>,
    listedAt: number,
  ): Map<number, { raw: RawProcessInfo; elapsedSec?: number; startedAt?: number }> {
    const extras = new Map<number, { raw: RawProcessInfo; elapsedSec?: number; startedAt?: number }>();
    for (const raw of tree.raws) {
      if (this.tracked.has(raw.pid) || raw.pid === this.selfPid || selfAncestors.has(raw.pid)) continue;
      for (const cur of tree.ancestors(raw.pid)) {
        if (cur === this.selfPid) break;
        const ancestor = this.tracked.get(cur);
        if (ancestor?.category === 'agent') {
          if (ancestor.pauseTarget && !hostOnTheWay(tree, raw.pid, cur)) {
            const elapsedSec = raw.etime !== undefined ? parseElapsedTime(raw.etime).elapsedSec : undefined;
            extras.set(raw.pid, {
              raw,
              elapsedSec,
              startedAt: elapsedSec === undefined ? undefined : listedAt - elapsedSec * 1000,
            });
          }
          break;
        }
      }
    }
    return extras;
  }

  /**
   * Remembers the descendants of a process and returns when a new one last appeared. The ones
   * there when watching starts are not new: an agent's MCP servers run all the time.
   */
  private trackChildren(pid: number, current: number[], now: number, reusedPid: boolean): number | undefined {
    const state = this.children.get(pid);
    if (!state || reusedPid) {
      this.children.set(pid, { known: new Set(current) });
      return undefined;
    }
    for (const child of current) {
      if (!state.known.has(child)) state.lastNewAt = now;
    }
    // Only the living ones: a PID used again later is a new process
    state.known = new Set(current);
    return state.lastNewAt;
  }

  /**
   * Records a CPU time sample and returns the CPU time used over the last staleQuietSec, or
   * undefined when the CPU time is unknown or the process has not been watched that long.
   */
  private cpuUsedInWindow(pid: number, cpuTimeSec: number | undefined, now: number): number | undefined {
    if (cpuTimeSec === undefined) {
      this.cpuSamples.delete(pid);
      return undefined;
    }
    const samples = this.cpuSamples.get(pid) ?? [];
    const last = samples[samples.length - 1];
    // a lower value means the PID was reused by another process: start over
    if (last && cpuTimeSec < last.cpuTimeSec) samples.length = 0;
    if (samples.length === 0 || now - samples[samples.length - 1].at >= CPU_SAMPLE_SPACING_MS) {
      samples.push({ at: now, cpuTimeSec });
    }
    const windowStart = now - this.staleQuietSec * 1000;
    // keep the newest sample at or before the window start as its anchor, drop the older ones
    while (samples.length > 1 && samples[1].at <= windowStart) samples.shift();
    this.cpuSamples.set(pid, samples);
    const anchor = samples[0];
    if (anchor.at > windowStart) return undefined;
    return Math.max(0, cpuTimeSec - anchor.cpuTimeSec);
  }

  public getProcesses(): MonitoredProcess[] {
    const rank = (s: ProcessHealthStatus): number => {
      if (s === 'FROZEN') return 0;
      if (s === 'STALE') return 1;
      if (s === 'ACTIVE') return 2;
      if (s === 'STANDBY') return 3;
      return 4;
    };

    return Array.from(this.tracked.values()).sort((a, b) => {
      const rDiff = rank(a.status) - rank(b.status);
      if (rDiff !== 0) return rDiff;
      return b.memoryMb - a.memoryMb;
    });
  }

  public getFrozenProcesses(): MonitoredProcess[] {
    return this.getProcesses().filter((p) => p.status === 'FROZEN' || p.status === 'STALE');
  }

  public isTracked(pid: number): boolean {
    return this.tracked.has(pid);
  }

  /**
   * Parent PID as of the last scan, for every process, listed or not. A walk up the tree over the
   * list alone stops at the first shell or npx in between.
   */
  public parentOf(pid: number): number | undefined {
    return this.lastScan.tree.parentOf(pid);
  }

  /**
   * Terminates one monitored process: SIGTERM first, SIGKILL if it is still alive after the
   * grace period. Only PIDs from the current process list can be terminated — this is never
   * a general-purpose kill for arbitrary PIDs.
   */
  public killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (pid === this.selfPid) return false;
    const proc = this.tracked.get(pid);
    if (!proc) return false;
    // The list is up to one scan old: the process may have exited and its PID gone to a new one,
    // which is younger than the listed process was. Pause has checked this since fe40c47; kill did
    // not (external audit, 21.11.2026)
    if (this.isYoungerThanListed(pid, proc.elapsedSec)) return false;

    const sent = this.processKiller(pid, signal);
    if (!sent) return false;
    // A held process only acts on SIGTERM once it runs again
    if (this.paused.has(pid)) this.processKiller(pid, 'SIGCONT');
    this.forgetHold(pid);

    this.tracked.delete(pid);
    this.alertedPids.delete(pid);
    // Out of `tracked`, the pruning after a scan never reaches these again: a new process under
    // this PID would inherit their history (external audit, 21.11.2026)
    this.cpuSamples.delete(pid);
    this.children.delete(pid);
    this.footprints.delete(pid);
    this.emit('process-killed', { pid, process: proc, signal } satisfies ProcessKilledEvent);

    if (signal !== 'SIGKILL' && this.killGraceMs > 0) {
      const timer = setTimeout(() => this.escalateKill(pid), this.killGraceMs);
      timer.unref();
      // An earlier timer for this PID would escalate the new entry before its grace period ends
      const earlier = this.terminating.get(pid);
      if (earlier) clearTimeout(earlier.timer);
      this.terminating.set(pid, { timer, process: proc, sentAt: this.monotonicNow() });
    }
    return true;
  }

  /** True when `ps` reads the PID as younger than the listed process was at its scan (2 s slack: etime has whole seconds). */
  private isYoungerThanListed(pid: number, listedAgeSec: number): boolean {
    const age = this.processAge(pid);
    return age !== undefined && age + 2 < listedAgeSec;
  }

  private escalateKill(pid: number): void {
    const pending = this.terminating.get(pid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.terminating.delete(pid);
    if (!this.processAlive(pid)) return;
    // The process may have exited on SIGTERM and the system handed its PID to a new one within the
    // grace period: a process younger than our SIGTERM is not the one that was confirmed
    const age = this.processAge(pid);
    if (age !== undefined && age + 1 < Math.max(0, this.monotonicNow() - pending.sentAt) / 1000) return;
    // or, gone and replaced before SIGTERM, a process younger than the one that was listed
    if (age !== undefined && age + 2 < pending.process.elapsedSec) return;
    if (this.processKiller(pid, 'SIGKILL')) {
      this.emit('process-killed', {
        pid,
        process: pending.process,
        signal: 'SIGKILL',
        escalated: true,
      } satisfies ProcessKilledEvent);
    }
  }

  /** What `pause` would hold right now: the agents of the watched repository and what they started. */
  public getPauseTargets(): PauseTarget[] {
    // Each from the scan that saw it: a scan in flight already moved lastScanAt, not the list
    // (safety review, 21.11.2026: the brake held nothing)
    const listed: PauseTarget[] = this.getProcesses()
      .filter((proc) => proc.pauseTarget && !proc.paused)
      .map((proc) => ({
        pid: proc.pid,
        cmd: proc.cmd,
        category: proc.category,
        cwd: proc.cwd,
        listed: true,
        firstSeenAt: proc.firstSeenAt,
        startedAt: proc.startedAt,
        elapsedSec: proc.elapsedSec,
      }));
    const unlisted: PauseTarget[] = Array.from(this.pauseExtras.values())
      .filter(({ raw }) => !this.paused.has(raw.pid))
      .map(({ raw, elapsedSec, startedAt }) => ({
        pid: raw.pid,
        cmd: formatReadableCmd(raw.name, raw.cmd ?? raw.name),
        category: 'child' as const,
        listed: false,
        startedAt,
        elapsedSec,
      }));
    return [...listed, ...unlisted];
  }

  /** True when this PID is held and still names the process that was held. */
  private stillHeld(raw: RawProcessInfo, listedAt: number, heldAfterList = false): boolean {
    if (!this.paused.has(raw.pid)) return false;
    // held after this list was read: `raw` may be the process that had the PID before
    if (heldAfterList) return true;
    const since = this.heldSince.get(raw.pid);
    if (since && raw.etime !== undefined) {
      const expected = since.elapsedSec + Math.max(0, listedAt - since.at) / 1000;
      if (parseElapsedTime(raw.etime).elapsedSec + 2 < expected) {
        // The held process is gone and the PID names another one, which was never held
        this.forgetHold(raw.pid);
        return false;
      }
    }
    return true;
  }

  /** PIDs strayps is holding right now. */
  public getPausedPids(): number[] {
    return Array.from(this.paused);
  }

  /**
   * Holds the pause targets with SIGSTOP. Nothing is terminated and nothing is lost: `resume`
   * continues every process where it stopped. A long autonomous run is paid work; an emergency
   * brake must not throw it away.
   *
   * With `confirmed`, the targets a person was shown, each still the same process: the list can
   * change while the question is open (external audit, 21.11.2026). Of what changed, only what the
   * confirmed agents started in the meantime is held too, never a new agent (`alsoHeld`).
   */
  public pauseTargets(confirmed?: PauseTarget[]): PauseOutcome {
    // Listed in both: the time strayps first saw it, exact. Otherwise the start time, which is
    // known to a second from `etime`, so within 2 s
    const same = (a: PauseTarget, b: PauseTarget): boolean => {
      if (a.pid !== b.pid) return false;
      if (a.firstSeenAt !== undefined && b.firstSeenAt !== undefined) return a.firstSeenAt === b.firstSeenAt;
      if (a.startedAt === undefined || b.startedAt === undefined) return a.startedAt === b.startedAt;
      return Math.abs(a.startedAt - b.startedAt) <= 2000;
    };
    let targets = this.getPauseTargets();
    let gone: number[] = [];
    let notAsked: number[] = [];
    if (confirmed) {
      for (const target of targets) if (!confirmed.some((c) => same(c, target))) notAsked.push(target.pid);
      for (const c of confirmed) if (!targets.some((target) => same(c, target))) gone.push(c.pid);
      targets = targets.filter((target) => confirmed.some((c) => same(c, target)));
    }
    // The list is up to one scan old. A process held under a reused PID would look new to the next
    // scan, drop out of what strayps holds and stay stopped: its age now must fit
    const ages = this.processAges(targets.map((t) => t.pid));
    const held: number[] = [];
    const heldAgents = new Set<number>();
    // The agents first, so they start nothing new while what they run is held
    targets.sort((a, b) => Number(b.category === 'agent') - Number(a.category === 'agent'));
    for (const target of targets) {
      // the age and monotonic time of the scan that saw it, so the next scans compare like with like
      const at =
        target.startedAt !== undefined && target.elapsedSec !== undefined
          ? target.startedAt + target.elapsedSec * 1000
          : this.lastScan.at;
      if (this.youngerThanExpected(ages.get(target.pid), target.elapsedSec, at)) {
        gone.push(target.pid);
        continue;
      }
      if (this.hold(target.pid, target.elapsedSec, at)) {
        held.push(target.pid);
        if (target.category === 'agent') heldAgents.add(target.pid);
      }
    }
    // An agent at work starts its next tool call while the person reads the question; held only
    // as far as the question went, the agent stopped and the call ran on (maintainer decision,
    // 22.11.2026). The agents are stopped now and start nothing more.
    const { alsoHeld, missed, alive } = this.holdWhatTheyStarted(heldAgents);
    held.push(...alsoHeld);
    // A PID held now is neither "not held" nor "keeps running"; one the last look missed has ended
    gone = gone.filter((pid) => !alsoHeld.includes(pid));
    notAsked = Array.from(new Set([...notAsked, ...missed])).filter(
      (pid) => !held.includes(pid) && (alive === undefined || alive.has(pid)),
    );
    if (held.length > 0) this.emit('processes-paused', held);
    return { pids: held, gone, notAsked, alsoHeld };
  }

  /**
   * True when `ps` reads the PID as younger than the process seen `elapsedSec` old at `at`
   * (monotonic clock) must be by now: the PID names another process. The same test as `stillHeld`,
   * so that nothing is held that the next scan would take for another process, forget, and leave
   * stopped.
   */
  private youngerThanExpected(age: number | undefined, elapsedSec: number | undefined, at: number): boolean {
    if (age === undefined || elapsedSec === undefined) return false;
    return age + 2 < elapsedSec + Math.max(0, this.monotonicNow() - at) / 1000;
  }

  /** SIGSTOP for one process, remembered with its age at `at` (monotonic clock) to tell a reused PID later. */
  private hold(pid: number, elapsedSec: number | undefined, at: number): boolean {
    if (pid === this.selfPid || this.lastSelfAncestors.has(pid) || !this.processKiller(pid, 'SIGSTOP')) return false;
    this.paused.add(pid);
    this.holdCount += 1;
    this.holdNumber.set(pid, this.holdCount);
    if (elapsedSec !== undefined) this.heldSince.set(pid, { elapsedSec, at });
    else this.heldSince.delete(pid);
    const listed = this.tracked.get(pid);
    if (listed) listed.paused = true;
    // Whatever ends strayps from now on (a crash, process.exit, an uncaught exception, the normal
    // shutdown) must continue what it holds: a stopped agent stays stopped forever. Only SIGKILL
    // skips this, and nothing can run then.
    if (!this.exitHookInstalled) {
      process.on('exit', this.continueOnExit);
      this.exitHookInstalled = true;
    }
    return true;
  }

  /** Forgets that a PID is held; the caller continues it, or knows that it is gone. */
  private forgetHold(pid: number): void {
    this.paused.delete(pid);
    this.heldSince.delete(pid);
    this.holdNumber.delete(pid);
  }

  /**
   * Holds what the given agents (held just now) started and nothing holds yet, as a new look at the
   * process table shows it; when the table cannot be read, as the last scan saw it. Looks again
   * while a look held something: a tool call can fork between a look and its SIGSTOP. Out of looks
   * or time, one more look only names what still runs (`missed`), as it does with every new agent
   * below them. `alive` is every PID of the last new look, undefined without one.
   */
  private holdWhatTheyStarted(agents: Set<number>): { alsoHeld: number[]; missed: number[]; alive?: Set<number> } {
    const alsoHeld: number[] = [];
    const missed = new Set<number>();
    let alive: Set<number> | undefined;
    if (agents.size === 0) return { alsoHeld, missed: [] };
    const startedAt = this.monotonicNow();
    for (let look = 0; ; look++) {
      let fresh: RawProcessInfo[] | undefined;
      try {
        fresh = this.processTree();
      } catch {
        fresh = undefined;
      }
      const tree = fresh ? new ProcessTree(fresh) : this.lastScan.tree;
      // the ages in `tree` are those of this moment, or of the last scan (monotonic clock)
      const at = fresh ? this.monotonicNow() : this.lastScan.at;
      if (fresh) alive = new Set(fresh.map((raw) => raw.pid));
      const { found, asked } = this.startedBy(agents, tree);
      for (const raw of asked) missed.add(raw.pid);
      if (look >= PAUSE_LOOKS || this.monotonicNow() - startedAt > PAUSE_LOOK_BUDGET_MS) {
        for (const raw of found) missed.add(raw.pid);
        break;
      }
      const ages = this.processAges(found.map((raw) => raw.pid));
      let heldNow = false;
      for (const raw of found) {
        const elapsedSec = raw.etime !== undefined ? parseElapsedTime(raw.etime).elapsedSec : undefined;
        if (this.youngerThanExpected(ages.get(raw.pid), elapsedSec, at)) continue;
        if (this.hold(raw.pid, elapsedSec, at)) {
          alsoHeld.push(raw.pid);
          heldNow = true;
        }
      }
      // The last scan shows the same each time; a new look shows more only below what was just held
      if (!fresh || !heldNow) break;
    }
    return { alsoHeld, missed: Array.from(missed).filter((pid) => !alsoHeld.includes(pid)), alive };
  }

  /**
   * What runs below the given agents in `tree`, parents first: `found` is what pause may hold and
   * does not hold yet. Never what a person has to be asked about first, nor anything below it: a
   * process recognized as an agent (by its name, the `agents` setting or the MCP server it
   * started), which is named in `asked`; an editor, desktop app or terminal; strayps itself and the
   * wrappers that started it.
   */
  private startedBy(agents: Set<number>, tree: ProcessTree): { found: RawProcessInfo[]; asked: RawProcessInfo[] } {
    const selfChain = new Set<number>([this.selfPid, ...tree.ancestors(this.selfPid, this.lastScan.tree)]);

    // Everything below the agents, breadth first: parents before what they run
    const below = tree.below(agents);

    const categories = new Map<number, ProcessCategory | undefined>();
    const categoryOf = (pid: number): ProcessCategory | undefined => {
      if (!categories.has(pid)) {
        const raw = tree.get(pid);
        categories.set(pid, raw ? recognizeProcess(raw, this.agentNames)?.category : undefined);
      }
      return categories.get(pid);
    };
    // The client of an MCP server is an agent, whatever it is called (agent recognition, rule 3).
    // A client below the agents has its servers below them as well.
    const clients = new Set<number>();
    for (const raw of below) {
      if (categoryOf(raw.pid) !== 'mcp') continue;
      const client = findMcpClient(raw, tree, categoryOf);
      if (client !== undefined) clients.add(client);
    }
    const isAgent = (raw: RawProcessInfo): boolean =>
      this.tracked.get(raw.pid)?.category === 'agent' || categoryOf(raw.pid) === 'agent' || clients.has(raw.pid);

    // Again from the agents, without passing what has to be asked about
    const found: RawProcessInfo[] = [];
    const asked: RawProcessInfo[] = [];
    const reached = new Set<number>(agents);
    for (const raw of below) {
      if (!reached.has(raw.ppid ?? -1) || selfChain.has(raw.pid)) continue;
      // an agent first: it is named, whatever program runs it
      if (isAgent(raw)) {
        asked.push(raw);
        continue;
      }
      if (isAppOrTerminal(raw)) continue;
      reached.add(raw.pid);
      if (!this.paused.has(raw.pid) && !this.terminating.has(raw.pid)) found.push(raw);
    }
    return { found, asked };
  }

  /** Continues every process strayps is holding (SIGCONT). */
  public resumePaused(): number[] {
    const resumed: number[] = [];
    for (const pid of Array.from(this.paused)) {
      this.forgetHold(pid);
      const proc = this.tracked.get(pid);
      if (proc) proc.paused = false;
      if (this.processKiller(pid, 'SIGCONT')) resumed.push(pid);
    }
    if (this.exitHookInstalled) {
      process.off('exit', this.continueOnExit);
      this.exitHookInstalled = false;
    }
    if (resumed.length > 0) this.emit('processes-resumed', resumed);
    return resumed;
  }

}
