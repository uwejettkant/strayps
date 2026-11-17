import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessHealthStatus = 'ACTIVE' | 'IDLE' | 'STANDBY' | 'STALE' | 'FROZEN';
export type ProcessCategory = 'agent' | 'mcp' | 'playwright' | 'chromium' | 'node';
export type ProcessKillSafety = 'safe-to-kill' | 'standby-mcp' | 'active-repo';

export interface RawProcessInfo {
  pid: number;
  ppid?: number;
  name: string;
  cmd?: string;
  cpu?: number;
  memory?: number;
  rssKb?: number;
  etime?: string;
  cwd?: string;
}

export interface MonitoredProcess {
  pid: number;
  ppid?: number;
  name: string;
  cmd: string;
  cwd?: string;
  category: ProcessCategory;
  cpu: number;
  memory: number;
  memoryMb: number;
  uptime: string;
  elapsedSec: number;
  firstSeenAt: number;
  lastActiveAt: number;
  silenceSec: number;
  status: ProcessHealthStatus;
  safety: ProcessKillSafety;
  reason: string;
  /** True if the process runs inside the watched repository or descends from a process that does. */
  inWatchedRepo: boolean;
  /** Application the process tree hangs off (VS Code, Claude Desktop, a terminal, ...), if recognizable. */
  host?: string;
}

export interface ProcessMonitorOptions {
  rootDir?: string;
  pollIntervalMs?: number;
  mcpSilenceTimeoutSec?: number;
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
  /** Time a process gets to exit after SIGTERM before SIGKILL is sent (default 3000 ms, 0 disables). */
  killGraceMs?: number;
}

export interface ProcessKilledEvent {
  pid: number;
  process?: MonitoredProcess;
  signal: NodeJS.Signals;
  /** True when SIGKILL followed an ignored SIGTERM. */
  escalated?: boolean;
}

const TARGET_KEYWORDS = [
  'claude',
  'codex',
  'aider',
  'mcp',
  'modelcontextprotocol',
  'playwright',
  'chromium',
  'chrome-devtools',
  'puppeteer',
  'node',
];

const IGNORED_SYSTEM_PATTERNS = [
  '/applications/claude.app/contents/macos/claude',
  '/applications/claude.app/contents/frameworks/',
  'claude helper',
  'contents/helpers/disclaimer',
  'cursoruiviewservice',
  'crashpad_handler',
  'gpuservice',
  'com.apple.webkit.',
  '.xpc/',
  'plugin-container.app',
];

/** Applications a process tree can hang off. First match on the nearest ancestor wins. */
const HOST_PATTERNS: Array<[RegExp, string]> = [
  [/visual studio code|code helper|\/code\.app\/|code - insiders|vscode-server|vscodium/i, 'VS Code'],
  [/\/cursor\.app\/|cursor helper/i, 'Cursor'],
  [/windsurf/i, 'Windsurf'],
  [/antigravity/i, 'Antigravity'],
  [/\/applications\/claude\.app\//i, 'Claude Desktop'],
  [/\/zed\.app\//i, 'Zed'],
  [/jetbrains|intellij|webstorm|pycharm|goland|phpstorm|rubymine/i, 'JetBrains IDE'],
  [/(^|[\s/])tmux(\s|:|$)/i, 'tmux'],
  [/(^|[\s/])sshd(\s|:|$)/i, 'SSH session'],
  [
    /iterm|\/terminal\.app\/|\/warp\.app\/|ghostty|kitty|alacritty|wezterm|\/hyper\.app\/|konsole|gnome-terminal|xterm/i,
    'terminal',
  ],
];

/**
 * Parses POSIX `ps` elapsed time (`[[dd-]hh:]mm:ss`) into seconds and a compact human label.
 */
export function parseElapsedTime(etime?: string): { elapsedSec: number; formattedUptime: string } {
  if (!etime || !etime.trim()) {
    return { elapsedSec: 0, formattedUptime: '0s' };
  }

  const raw = etime.trim();
  let days = 0;
  let timePart = raw;

  if (raw.includes('-')) {
    const [dStr, rest] = raw.split('-');
    days = Number(dStr) || 0;
    timePart = rest ?? '00:00';
  }

  const parts = timePart.split(':').map((n) => Number(n) || 0);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  }

  const elapsedSec = days * 86400 + hours * 3600 + minutes * 60 + seconds;

  let formattedUptime: string;
  if (days > 0) {
    formattedUptime = `${days}d ${hours}h`;
  } else if (hours > 0) {
    formattedUptime = `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    formattedUptime = `${minutes}m ${seconds}s`;
  } else {
    formattedUptime = `${seconds}s`;
  }

  return { elapsedSec, formattedUptime };
}

/**
 * Parses `lsof -a -d cwd -p <pids> -Fn` output (`p<pid>` / `n<path>` records).
 */
export function parseLsofCwdOutput(stdout: string): Map<number, string> {
  const cwdMap = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('n') && currentPid !== null) {
      const rawPath = line.slice(1).trim();
      if (rawPath && rawPath !== '/') {
        cwdMap.set(currentPid, rawPath);
      }
    }
  }
  return cwdMap;
}

/**
 * Resolves the working directory (`cwd`) for a list of PIDs: `/proc/<pid>/cwd` on Linux,
 * `lsof` elsewhere. Unresolvable PIDs are simply missing from the result.
 */
export async function resolveProcessCwds(
  pids: number[],
  readLink: (target: string) => string = fs.readlinkSync,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, string>> {
  const cwdMap = new Map<number, string>();
  if (pids.length === 0) return cwdMap;

  if (platform === 'linux') {
    for (const pid of pids) {
      try {
        const cwd = readLink(`/proc/${pid}/cwd`);
        if (cwd && cwd !== '/') cwdMap.set(pid, cwd);
      } catch {
        // Process gone or owned by another user
      }
    }
    if (cwdMap.size > 0) return cwdMap;
  }

  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'],
      { timeout: 1500 },
    );
    return parseLsofCwdOutput(stdout);
  } catch (err) {
    // lsof exits non-zero when some PIDs vanished but still prints the rest
    const partial = (err as { stdout?: unknown }).stdout;
    if (typeof partial === 'string' && partial.length > 0) {
      return parseLsofCwdOutput(partial);
    }
    // lsof missing, permission boundary, or timeout
  }
  return cwdMap;
}

function formatReadableCmd(rawName: string, rawCmd: string): string {
  const cmd = rawCmd.trim();

  if (
    cmd.includes('claude-code') ||
    cmd.includes('/native-binary/claude') ||
    cmd.includes('/claude.app/Contents/MacOS/claude')
  ) {
    const modelMatch = cmd.match(/--model[=\s]+([^\s]+)/);
    const modelSuffix = modelMatch ? ` (${modelMatch[1]})` : '';
    return `claude-code${modelSuffix}`;
  }

  if (rawName === 'claude' || cmd === 'claude' || cmd.startsWith('claude ')) {
    return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
  }

  const binMatch = cmd.match(/\.bin\/([^\s]+)/);
  if (binMatch) {
    return `node .bin/${binMatch[1]}`;
  }

  return cmd.length > 100 ? `${cmd.slice(0, 97)}...` : cmd;
}

/**
 * Default OS process lister using POSIX `ps` (with RSS in KB and elapsed uptime) and `ps-list` fallback.
 */
export async function defaultProcessLister(): Promise<RawProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-Ao', 'pid,ppid,rss,pcpu,pmem,etime,comm,args'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const lines = stdout.trim().split('\n').slice(1);
    const results: RawProcessInfo[] = [];

    for (const line of lines) {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      results.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]) || 0,
        cpu: Number(match[4]) || 0,
        memory: Number(match[5]) || 0,
        etime: match[6],
        name: match[7],
        cmd: match[8],
      });
    }
    return results;
  } catch {
    try {
      const psListMod = await import('ps-list');
      const psList = psListMod.default;
      const list = await psList();
      return list.map((proc) => ({
        pid: proc.pid,
        ppid: proc.ppid,
        name: proc.name,
        cmd: proc.cmd ?? proc.name,
        cpu: typeof proc.cpu === 'number' ? proc.cpu : 0,
        memory: typeof proc.memory === 'number' ? proc.memory : 0,
      }));
    } catch {
      return [];
    }
  }
}

export function defaultProcessKiller(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ProcessMonitor extends EventEmitter {
  private rootDir: string;
  private pollIntervalMs: number;
  private mcpSilenceTimeoutSec: number;
  private staleSessionSec: number;
  private agentActive: boolean;
  private selfPid: number;
  private killGraceMs: number;
  private processLister: () => Promise<RawProcessInfo[]>;
  private processKiller: (pid: number, signal?: NodeJS.Signals) => boolean;
  private processAlive: (pid: number) => boolean;
  private cwdResolver: (pids: number[]) => Promise<Map<number, string>>;

  private timer: NodeJS.Timeout | null = null;
  private tracked: Map<number, MonitoredProcess> = new Map();
  private alertedPids: Set<number> = new Set();
  private lastFileActivityAt: number = Date.now();
  private scanInFlight: Promise<MonitoredProcess[]> | null = null;
  /** PIDs that received SIGTERM and are inside their grace period. */
  private terminating: Map<number, { timer: NodeJS.Timeout; process: MonitoredProcess }> = new Map();

  constructor(options: ProcessMonitorOptions = {}) {
    super();
    const resolvedRoot = path.resolve(options.rootDir ?? process.cwd());
    try {
      // Match the watcher, which also works on the real path (e.g. /tmp -> /private/tmp on macOS)
      this.rootDir = fs.realpathSync(resolvedRoot);
    } catch {
      this.rootDir = resolvedRoot;
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.mcpSilenceTimeoutSec = options.mcpSilenceTimeoutSec ?? 45;
    this.staleSessionSec = (options.staleSessionHours ?? 6) * 3600;
    this.agentActive = options.agentActive ?? true;
    this.selfPid = options.selfPid ?? process.pid;
    this.killGraceMs = options.killGraceMs ?? 3000;
    this.processLister = options.processLister ?? defaultProcessLister;
    this.processKiller = options.processKiller ?? defaultProcessKiller;
    this.processAlive =
      options.processAlive ?? (options.processKiller ? () => false : defaultProcessAlive);
    this.cwdResolver =
      options.cwdResolver ??
      (options.processLister ? async () => new Map<number, string>() : resolveProcessCwds);
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

  public setAgentActive(active: boolean): void {
    this.agentActive = active;
  }

  public isAgentActive(): boolean {
    return this.agentActive;
  }

  /**
   * Called by the file watcher whenever a file event occurs in the repo,
   * refreshing the heartbeat for active processes.
   */
  public recordFileActivity(now: number = Date.now()): void {
    this.lastFileActivityAt = now;
    for (const proc of this.tracked.values()) {
      proc.lastActiveAt = now;
      proc.silenceSec = 0;
      if (proc.status === 'FROZEN') {
        proc.status = 'ACTIVE';
        this.alertedPids.delete(proc.pid);
      }
    }
  }

  /**
   * Performs a single scan of running processes and updates inactivity timers,
   * real RAM usage (MB), uptime, and kill-safety classification.
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

  private async performScan(now: number): Promise<MonitoredProcess[]> {
    const rawList = await this.processLister();
    const seenPids = new Set<number>();

    // Map all live PIDs, parent-child links, and parent PIDs that have children
    const allLivePids = new Set<number>();
    const rawByPid = new Map<number, RawProcessInfo>();
    const parentByPid = new Map<number, number>();
    const parentPidsWithChildren = new Set<number>();
    for (const r of rawList) {
      allLivePids.add(r.pid);
      rawByPid.set(r.pid, r);
      if (r.ppid) {
        parentByPid.set(r.pid, r.ppid);
        parentPidsWithChildren.add(r.ppid);
      }
    }

    // The chain of processes that launched this watchdog (npm, tsx, npx wrappers, the shell).
    const selfAncestors = new Set<number>();
    for (let cur = parentByPid.get(this.selfPid), depth = 0; cur && cur > 1 && depth < 32; depth++) {
      selfAncestors.add(cur);
      cur = parentByPid.get(cur);
    }

    const candidates: Array<{ raw: RawProcessInfo; category: ProcessCategory }> = [];
    for (const raw of rawList) {
      if (raw.pid === this.selfPid) continue;
      if (this.terminating.has(raw.pid)) continue;
      const cmdLower = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      // Skip `npm exec` wrapper parents when their actual node child process is running
      if (cmdLower.includes('npm exec ') && parentPidsWithChildren.has(raw.pid)) {
        continue;
      }
      const category = this.classifyProcess(raw);
      if (!category) continue;
      // Wrappers that started the watchdog itself are not agent work; killing them would kill us.
      if (selfAncestors.has(raw.pid) && category !== 'agent') continue;
      candidates.push({ raw, category });
    }

    const cwdMap = await this.cwdResolver(candidates.map((c) => c.raw.pid));
    const homeDir = os.homedir();

    const isInsideRoot = (cwd: string | undefined): boolean => {
      if (typeof cwd !== 'string' || cwd.length === 0) return false;
      const resolved = path.resolve(cwd);
      return resolved === this.rootDir || resolved.startsWith(this.rootDir + path.sep);
    };

    // PIDs whose own working directory lies in the watched repository
    const repoPids = new Set<number>();
    for (const { raw } of candidates) {
      if (isInsideRoot(raw.cwd ?? cwdMap.get(raw.pid))) repoPids.add(raw.pid);
    }

    const hasRepoAncestor = (pid: number): boolean => {
      let cur = parentByPid.get(pid);
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        if (repoPids.has(cur)) return true;
        cur = parentByPid.get(cur);
      }
      return false;
    };

    const detectHost = (raw: RawProcessInfo): string | undefined => {
      if (!raw.ppid) return undefined;
      if (raw.ppid === 1) return 'detached';
      let cur: number | undefined = raw.ppid;
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        const ancestor = rawByPid.get(cur);
        if (!ancestor) return undefined;
        const text = `${ancestor.name} ${ancestor.cmd ?? ''}`;
        for (const [pattern, label] of HOST_PATTERNS) {
          if (pattern.test(text)) return label;
        }
        cur = ancestor.ppid;
      }
      return undefined;
    };

    for (const { raw, category } of candidates) {
      seenPids.add(raw.pid);
      const cpu = Number(raw.cpu ?? 0);
      const memory = Number(raw.memory ?? 0);
      const memoryMb =
        typeof raw.rssKb === 'number'
          ? Number((raw.rssKb / 1024).toFixed(1))
          : Number((memory * 16).toFixed(1));

      const existing = this.tracked.get(raw.pid);
      const hasCpuActivity = cpu > 0;
      const lastActiveAt = existing
        ? hasCpuActivity
          ? now
          : Math.max(existing.lastActiveAt, this.lastFileActivityAt)
        : Math.max(now, this.lastFileActivityAt);

      const silenceSec = Math.max(0, Math.floor((now - lastActiveAt) / 1000));
      const { elapsedSec, formattedUptime } = raw.etime
        ? parseElapsedTime(raw.etime)
        : { elapsedSec: silenceSec, formattedUptime: `${silenceSec}s` };

      const rawCwd = raw.cwd ?? cwdMap.get(raw.pid);
      const displayCwd = rawCwd
        ? rawCwd.startsWith(homeDir)
          ? `~${rawCwd.slice(homeDir.length)}`
          : rawCwd
        : undefined;

      const isInWatchedRepo = isInsideRoot(rawCwd);
      // A tool process started by an agent of the watched repo belongs to that session,
      // wherever its own working directory is (many MCP servers run in "/" or their install dir).
      const belongsToWatchedRepo = isInWatchedRepo || hasRepoAncestor(raw.pid);

      const isOtherRepo =
        typeof rawCwd === 'string' && rawCwd.length > 0 && !belongsToWatchedRepo;

      const host = detectHost(raw);
      const hostNote = host && host !== 'detached' ? `, attached to ${host}` : '';

      const isStaleByAge = elapsedSec >= this.staleSessionSec;
      const isOrphaned = raw.ppid === 1 && category !== 'agent';
      const rawCmdLower = (raw.cmd ?? '').toLowerCase();
      const isDevServer =
        rawCmdLower.includes('next dev') ||
        rawCmdLower.includes('turbopack') ||
        rawCmdLower.includes('vite') ||
        rawCmdLower.includes('cli.js test-server');

      // Check whether this process (or its parent wrapper) has a living parent agent
      const hasLiveParentChain = Boolean(
        raw.ppid &&
          allLivePids.has(raw.ppid) &&
          (!parentByPid.get(raw.ppid) ||
            parentByPid.get(raw.ppid) === 1 ||
            allLivePids.has(parentByPid.get(raw.ppid)!)),
      );

      let status: ProcessHealthStatus = hasCpuActivity ? 'ACTIVE' : 'IDLE';
      let safety: ProcessKillSafety = 'active-repo';
      let reason = 'Active in current repository';

      if (!isOtherRepo && isDevServer) {
        status = 'ACTIVE';
        safety = 'active-repo';
        reason = `Running dev server in current repository (${formattedUptime})`;
      } else if (isOtherRepo && isStaleByAge) {
        // Process belongs to a DIFFERENT repository and has exceeded the stale age threshold
        status = 'STALE';
        safety = 'safe-to-kill';
        reason = `Old session in ${displayCwd} (${formattedUptime})${hostNote} — safe to kill`;
      } else if (!belongsToWatchedRepo && !rawCwd && isStaleByAge && cpu < 0.5 && category === 'mcp') {
        // Detached MCP process without a repository cwd, older than staleSessionHours
        status = 'STALE';
        safety = 'safe-to-kill';
        reason = `Stale detached MCP process (${formattedUptime} old)${hostNote} — safe to kill`;
      } else if (isOrphaned && !hasCpuActivity && elapsedSec >= this.mcpSilenceTimeoutSec) {
        status = 'FROZEN';
        safety = 'safe-to-kill';
        reason = `Orphaned process (PPID=1, ${formattedUptime}) — safe to kill`;
      } else if (category === 'mcp' && !hasCpuActivity && hasLiveParentChain) {
        // MCP child server whose parent is alive: 0% CPU is normal standby behavior
        // while it waits for stdin tool requests, regardless of session age.
        status = 'STANDBY';
        safety = 'standby-mcp';
        reason = `Standby MCP child (PPID ${raw.ppid} alive, age ${formattedUptime}) — waiting for tool call`;
      } else if (belongsToWatchedRepo && category === 'agent') {
        // An agent session in the currently watched repository is NEVER marked stale or frozen
        // just because the developer has been working in the repo for hours or is thinking.
        status = hasCpuActivity ? 'ACTIVE' : 'IDLE';
        safety = 'active-repo';
        reason = `Agent session in current repository (open for ${formattedUptime})`;
      } else if (this.agentActive && silenceSec >= this.mcpSilenceTimeoutSec && !isDevServer) {
        status = 'FROZEN';
        safety = 'safe-to-kill';
        reason = `No CPU or file activity for ${silenceSec}s — safe to kill`;
      } else if (category === 'mcp' && !hasCpuActivity) {
        reason = 'Idle MCP process waiting for requests';
      }

      const monitored: MonitoredProcess = {
        pid: raw.pid,
        ppid: raw.ppid,
        name: raw.name,
        cmd: formatReadableCmd(raw.name, raw.cmd ?? raw.name),
        cwd: displayCwd,
        category,
        cpu,
        memory,
        memoryMb,
        uptime: formattedUptime,
        elapsedSec,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastActiveAt,
        silenceSec,
        status,
        safety,
        reason,
        inWatchedRepo: belongsToWatchedRepo,
        host,
      };

      this.tracked.set(raw.pid, monitored);

      if ((status === 'FROZEN' || status === 'STALE') && !this.alertedPids.has(raw.pid)) {
        this.alertedPids.add(raw.pid);
        this.emit('process-frozen', monitored);
      } else if (status !== 'FROZEN' && status !== 'STALE' && this.alertedPids.has(raw.pid)) {
        this.alertedPids.delete(raw.pid);
        this.emit('process-recovered', monitored);
      }
    }

    for (const pid of Array.from(this.tracked.keys())) {
      if (!seenPids.has(pid)) {
        this.tracked.delete(pid);
        this.alertedPids.delete(pid);
      }
    }

    const processes = this.getProcesses();
    this.emit('scan-complete', processes);
    return processes;
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
   * Terminates one monitored process: SIGTERM first, SIGKILL if it is still alive after the
   * grace period. Only PIDs from the current process list can be terminated — this is never
   * a general-purpose kill for arbitrary PIDs.
   */
  public killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (pid === this.selfPid) return false;
    const proc = this.tracked.get(pid);
    if (!proc) return false;

    const sent = this.processKiller(pid, signal);
    if (!sent) return false;

    this.tracked.delete(pid);
    this.alertedPids.delete(pid);
    this.emit('process-killed', { pid, process: proc, signal } satisfies ProcessKilledEvent);

    if (signal !== 'SIGKILL' && this.killGraceMs > 0) {
      const timer = setTimeout(() => this.escalateKill(pid), this.killGraceMs);
      timer.unref();
      this.terminating.set(pid, { timer, process: proc });
    }
    return true;
  }

  private escalateKill(pid: number): void {
    const pending = this.terminating.get(pid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.terminating.delete(pid);
    if (!this.processAlive(pid)) return;
    if (this.processKiller(pid, 'SIGKILL')) {
      this.emit('process-killed', {
        pid,
        process: pending.process,
        signal: 'SIGKILL',
        escalated: true,
      } satisfies ProcessKilledEvent);
    }
  }

  /**
   * Terminates monitored processes machine-wide: everything tracked, or only what is
   * classified as safe to kill (stale / frozen).
   */
  public killAllMonitored(onlySafeToKill: boolean = false): number[] {
    return this.killWhere(
      (proc) =>
        !onlySafeToKill ||
        proc.status === 'FROZEN' ||
        proc.status === 'STALE' ||
        proc.safety === 'safe-to-kill',
    );
  }

  /**
   * Terminates the agent and tool processes that belong to the watched repository
   * (working directory inside it, or started by a process that is). Sessions in other
   * repositories are left alone.
   */
  public killInWatchedRepo(signal: NodeJS.Signals = 'SIGTERM'): number[] {
    return this.killWhere((proc) => proc.inWatchedRepo, signal);
  }

  private killWhere(
    predicate: (proc: MonitoredProcess) => boolean,
    signal: NodeJS.Signals = 'SIGTERM',
  ): number[] {
    const killedPids: number[] = [];
    for (const proc of Array.from(this.tracked.values())) {
      if (!predicate(proc)) continue;
      if (this.killProcess(proc.pid, signal)) {
        killedPids.push(proc.pid);
      }
    }
    return killedPids;
  }

  private classifyProcess(raw: RawProcessInfo): ProcessCategory | null {
    const haystack = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();

    if (IGNORED_SYSTEM_PATTERNS.some((pat) => haystack.includes(pat))) {
      return null;
    }

    if (!TARGET_KEYWORDS.some((kw) => haystack.includes(kw))) {
      return null;
    }

    if (
      raw.name === 'claude' ||
      haystack.includes('claude-code') ||
      haystack.includes('/native-binary/claude') ||
      haystack.includes('/claude.app/contents/macos/claude') ||
      haystack.includes('codex') ||
      haystack.includes('aider')
    ) {
      return 'agent';
    }

    if (haystack.includes('mcp') || haystack.includes('modelcontextprotocol')) {
      return 'mcp';
    }

    if (haystack.includes('playwright')) {
      return 'playwright';
    }
    if (haystack.includes('chromium') || haystack.includes('headless_shell')) {
      return 'chromium';
    }

    const normalizedRoot = this.rootDir.toLowerCase();
    if (
      haystack.includes('node') &&
      (haystack.includes(normalizedRoot) ||
        haystack.includes('tsx') ||
        haystack.includes('vitest') ||
        !raw.cmd ||
        raw.cmd === raw.name)
    ) {
      return 'node';
    }

    return null;
  }
}
