import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessHealthStatus = 'ACTIVE' | 'IDLE' | 'STANDBY' | 'STALE' | 'FROZEN';
export type ProcessCategory = 'agent' | 'mcp' | 'playwright' | 'chromium' | 'node';
/**
 * How a process was recognized as a coding agent: by a built-in program name, by a name from the
 * `agents` setting, or because it started an MCP server (whatever the agent is called).
 */
export type AgentDetection = 'name' | 'setting' | 'mcp-client';

export interface RawProcessInfo {
  pid: number;
  ppid?: number;
  /** Process group. Unknown when the fallback lister is used. */
  pgid?: number;
  name: string;
  cmd?: string;
  cpu?: number;
  memory?: number;
  rssKb?: number;
  etime?: string;
  /** CPU time used since the process started. Unknown when the fallback lister is used. */
  cpuTimeSec?: number;
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
  /** CPU time used since the process started, if the lister can read it. */
  cpuTimeSec?: number;
  silenceSec: number;
  /**
   * What the process looks like right now. STALE and FROZEN are observations, not a verdict:
   * nothing is labeled safe to kill, and nothing is terminated because of its status.
   */
  status: ProcessHealthStatus;
  reason: string;
  /** True if the process runs inside the watched repository or descends from a process that does. */
  inWatchedRepo: boolean;
  /**
   * `pause` holds this process: a coding agent of the watched repository, or a process one of them
   * started. Dev servers, editors and other sessions are never paused.
   */
  pauseTarget: boolean;
  /** Held with SIGSTOP by agent-leash; `resume` continues it where it stopped. */
  paused: boolean;
  /** Application the process tree hangs off (VS Code, Claude Desktop, a terminal, ...), if recognizable. */
  host?: string;
  /** Only for agents: how the process was recognized as one. */
  detectedBy?: AgentDetection;
  /** The nearest monitored agent this process was started by, directly or through launchers. */
  agentPid?: number;
}

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
  /** Time a process gets to exit after SIGTERM before SIGKILL is sent (default 3000 ms, 0 disables). */
  killGraceMs?: number;
  /** More program names to treat as coding agents (the `agents` setting); matched exactly. */
  agentNames?: string[];
}

export interface ProcessKilledEvent {
  pid: number;
  process?: MonitoredProcess;
  signal: NodeJS.Signals;
  /** True when SIGKILL followed an ignored SIGTERM. */
  escalated?: boolean;
}

/**
 * Agents recognized by the name of their program alone. Deliberately short, and it does not grow
 * with every new product: an agent that starts an MCP server is found through that server, and
 * users name any other agent in the `agents` setting.
 */
export const BUILT_IN_AGENT_NAMES: readonly string[] = ['claude', 'codex', 'aider'];

/** Programs that only start another program. Never the agent itself, whatever they launch. */
const LAUNCHER_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'nohup', 'timeout',
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'corepack', 'uv', 'uvx', 'pipx',
]);

/** Programs that run a script: the script's name is the program's real name. */
const INTERPRETER = /^(node|nodejs|bun|deno|ruby|tsx|ts-node|python(\d+(\.\d+)*)?)$/;
const OPTIONS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const INLINE_CODE_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/** Lower-case file name of a path; a login shell shows up as "-zsh". */
function baseName(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/^-/, '').toLowerCase();
}

function stripScriptExtension(name: string): string {
  return name.replace(/\.(m?js|cjs|ts|py)$/, '');
}

/**
 * The names a process runs as: its executable and, when that is an interpreter (node, python, ...),
 * the script or module it runs. Used to match agent names exactly instead of by substring, which
 * catches unrelated programs ("codex-mcp-server", "aider-stats.js").
 */
export function programNames(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): string[] {
  const names = new Set<string>();
  const executable = baseName(raw.name);
  if (executable) names.add(stripScriptExtension(executable));

  const args = (raw.cmd ?? '').trim().split(/\s+/).filter(Boolean);
  const first = args.length > 0 ? baseName(args[0]) : '';
  if (first) names.add(stripScriptExtension(first));

  if (INTERPRETER.test(first) || INTERPRETER.test(executable)) {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (INLINE_CODE_OPTIONS.has(arg)) break;
      if (arg === '-m') {
        if (args[i + 1]) names.add(baseName(args[i + 1]));
        break;
      }
      if (OPTIONS_WITH_VALUE.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith('-')) continue;
      names.add(stripScriptExtension(baseName(arg)));
      break;
    }
  }
  return Array.from(names);
}

const TARGET_KEYWORDS = [
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

/** Hosts that keep a process running without saying anyone still uses it. */
const NON_APP_HOSTS = new Set(['detached', 'tmux', 'SSH session', 'terminal']);

/** CPU time below this between two scans is measurement noise, not work. */
const CPU_TIME_TICK_SEC = 0.005;

/**
 * A session in another repository is called stale only after agent-leash has watched it for this
 * long and it used less than STALE_CPU_BUDGET_SEC of CPU time in that window. A freshly started
 * watchdog therefore calls nothing stale for this long.
 */
export const STALE_QUIET_SEC = 10 * 60;
/**
 * Idle is not zero: measured on 19.11.2026, idle agent processes used 0.00 to 0.2 s of CPU time
 * per 2 minutes (timers, housekeeping), working ones 2 to 17 s.
 */
export const STALE_CPU_BUDGET_SEC = 0.5;
/** Spacing of the CPU time samples kept per process for the window. */
const CPU_SAMPLE_SPACING_MS = 30_000;

function formatCpu(sec: number): string {
  return `${sec.toFixed(2)} s`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/**
 * Parses the CPU time a process has used so far, as `ps -o time` prints it: `mmm:ss.cc` on macOS,
 * `[dd-]hh:mm:ss` on Linux. Returns undefined for anything else, so a misread column never
 * passes for "no CPU used".
 */
export function parseCpuTime(time?: string): number | undefined {
  const match = time?.trim().match(/^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(?:\.(\d+))?$/);
  if (!match) return undefined;
  const [, days, a, b, c, fraction] = match;
  const whole =
    c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(days ?? 0) * 86400 + Number(a) * 3600 + Number(b) * 60 + Number(c);
  return fraction === undefined ? whole : whole + Number(`0.${fraction}`);
}

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
      ['-Ao', 'pid,ppid,pgid,rss,pcpu,pmem,etime,time,comm,args'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const lines = stdout.trim().split('\n').slice(1);
    const results: RawProcessInfo[] = [];

    for (const line of lines) {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      results.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        rssKb: Number(match[4]) || 0,
        cpu: Number(match[5]) || 0,
        memory: Number(match[6]) || 0,
        etime: match[7],
        cpuTimeSec: parseCpuTime(match[8]),
        name: match[9],
        cmd: match[10],
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
  private staleQuietSec: number;
  private agentActive: boolean;
  private selfPid: number;
  private killGraceMs: number;
  private processLister: () => Promise<RawProcessInfo[]>;
  private processKiller: (pid: number, signal?: NodeJS.Signals) => boolean;
  private processAlive: (pid: number) => boolean;
  private cwdResolver: (pids: number[]) => Promise<Map<number, string>>;
  private agentNames: Set<string> = new Set();

  private timer: NodeJS.Timeout | null = null;
  private tracked: Map<number, MonitoredProcess> = new Map();
  private paused: Set<number> = new Set();
  private alertedPids: Set<number> = new Set();
  /** CPU time samples per PID, oldest first, spaced CPU_SAMPLE_SPACING_MS apart. */
  private cpuSamples: Map<number, Array<{ at: number; cpuTimeSec: number }>> = new Map();
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
    this.staleQuietSec = options.staleQuietSec ?? STALE_QUIET_SEC;
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
    // Never leave an agent held when the watchdog goes away
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

    interface Candidate {
      raw: RawProcessInfo;
      category: ProcessCategory;
      detectedBy?: AgentDetection;
    }
    const candidates: Candidate[] = [];
    for (const raw of rawList) {
      if (raw.pid === this.selfPid) continue;
      if (this.terminating.has(raw.pid)) continue;
      const cmdLower = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      // Skip `npm exec` wrapper parents when their actual node child process is running
      if (cmdLower.includes('npm exec ') && parentPidsWithChildren.has(raw.pid)) {
        continue;
      }
      const classified = this.classifyProcess(raw);
      if (!classified) continue;
      // Wrappers that started the watchdog itself are not agent work; killing them would kill us.
      if (selfAncestors.has(raw.pid) && classified.category !== 'agent') continue;
      candidates.push({ raw, ...classified });
    }

    // Every MCP server is started by a client. A client that is not an editor, a desktop app or a
    // terminal is a coding agent, whatever it is called, so no list of agent products is needed.
    const candidateByPid = new Map(candidates.map((c) => [c.raw.pid, c]));
    for (const server of candidates.filter((c) => c.category === 'mcp')) {
      const clientPid = this.findMcpClient(
        server.raw,
        rawByPid,
        (pid) => candidateByPid.get(pid)?.category,
      );
      if (clientPid === undefined || clientPid === this.selfPid || this.terminating.has(clientPid)) {
        continue;
      }
      const known = candidateByPid.get(clientPid);
      if (known) {
        if (known.category !== 'agent') {
          known.category = 'agent';
          known.detectedBy = 'mcp-client';
        }
        continue;
      }
      const client: Candidate = { raw: rawByPid.get(clientPid)!, category: 'agent', detectedBy: 'mcp-client' };
      candidates.push(client);
      candidateByPid.set(clientPid, client);
    }

    const nearestAgent = (pid: number): number | undefined => {
      let cur = parentByPid.get(pid);
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        if (candidateByPid.get(cur)?.category === 'agent') return cur;
        cur = parentByPid.get(cur);
      }
      return undefined;
    };

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
    const belongsToRepo = (pid: number): boolean => repoPids.has(pid) || hasRepoAncestor(pid);

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

    for (const { raw, category, detectedBy } of candidates) {
      seenPids.add(raw.pid);
      const cpu = Number(raw.cpu ?? 0);
      const memory = Number(raw.memory ?? 0);
      const memoryMb =
        typeof raw.rssKb === 'number'
          ? Number((raw.rssKb / 1024).toFixed(1))
          : Number((memory * 16).toFixed(1));

      const existing = this.tracked.get(raw.pid);
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
      const quietLongEnough = usedInWindowSec !== undefined && usedInWindowSec < STALE_CPU_BUDGET_SEC;
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
      // PPID 1 alone does not mean the parent is gone: on macOS launchd is the parent of every app
      // started from the Dock or Finder, and makes each one the leader of its own process group.
      // A process whose parent died keeps the group it was started in. Without a known group
      // there is no evidence, so nothing is called orphaned.
      const isOrphaned =
        raw.ppid === 1 && raw.pgid !== undefined && raw.pgid !== raw.pid && category !== 'agent';
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

      // An idle MCP server of an open editor or desktop app waits for its next tool call; it was
      // called STALE after 10 idle minutes although the app was in use (20.11.2026). A terminal,
      // tmux or SSH session says nothing about whether anyone still uses what runs in it.
      const heldByRunningApp =
        hasLiveParentChain && raw.ppid !== 1 && host !== undefined && !NON_APP_HOSTS.has(host);

      // STALE and FROZEN describe what is observed. They are never presented as "safe to kill":
      // age and silence alone have been wrong about sessions that were still in use.
      let status: ProcessHealthStatus = hasCpuActivity ? 'ACTIVE' : 'IDLE';
      let reason = 'Active in current repository';

      if (!isOtherRepo && isDevServer) {
        status = 'ACTIVE';
        reason = `Running dev server in current repository (${formattedUptime})`;
      } else if (isOtherRepo && isStaleByAge && quietLongEnough) {
        // Age alone called sessions stale that were still in use at an open editor (audit D-01):
        // a session in another repository is stale only when it is old AND has used no CPU time
        // for a measured window.
        status = 'STALE';
        reason = `Session in ${displayCwd}, running for ${formattedUptime}, idle: ${formatCpu(usedInWindowSec)} CPU time in the last ${formatDuration(this.staleQuietSec)}${hostNote}`;
      } else if (isOtherRepo && isStaleByAge) {
        reason =
          cpuTimeSec === undefined
            ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; its CPU time cannot be read, so it is never called stale`
            : usedInWindowSec === undefined
              ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; watching for ${formatDuration(this.staleQuietSec)} whether it is still in use`
              : `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; in use: ${formatCpu(usedInWindowSec)} CPU time in the last ${formatDuration(this.staleQuietSec)}`;
      } else if (
        !belongsToWatchedRepo &&
        !rawCwd &&
        isStaleByAge &&
        quietLongEnough &&
        category === 'mcp' &&
        !heldByRunningApp
      ) {
        // Detached MCP process without a repository cwd, older than staleSessionHours
        status = 'STALE';
        reason = `MCP process without a working directory, running for ${formattedUptime}, idle: ${formatCpu(usedInWindowSec)} CPU time in the last ${formatDuration(this.staleQuietSec)}${hostNote}`;
      } else if (isOrphaned && !hasCpuActivity && elapsedSec >= this.mcpSilenceTimeoutSec) {
        status = 'FROZEN';
        reason = `Orphaned: its parent is gone (PPID 1), running for ${formattedUptime}`;
      } else if (category === 'mcp' && !hasCpuActivity && hasLiveParentChain) {
        // MCP child server whose parent is alive: 0% CPU is normal standby behavior
        // while it waits for stdin tool requests, regardless of session age.
        status = 'STANDBY';
        reason = `Standby MCP child (PPID ${raw.ppid} alive, age ${formattedUptime}) — waiting for tool call`;
      } else if (belongsToWatchedRepo && category === 'agent') {
        // An agent session in the currently watched repository is NEVER marked stale or frozen
        // just because the developer has been working in the repo for hours or is thinking.
        status = hasCpuActivity ? 'ACTIVE' : 'IDLE';
        reason = `Agent session in current repository (open for ${formattedUptime})`;
      } else if (this.agentActive && silenceSec >= this.mcpSilenceTimeoutSec && !isDevServer) {
        // Quiet is not frozen: a resting watch server, a browser or a session in another repo
        // waiting for its user were all called FROZEN after 45 s (audit D-02). Only a process
        // whose parent is gone (rule above) is called frozen.
        reason = `Quiet: no CPU or file activity for ${silenceSec}s`;
      } else if (category === 'mcp' && !hasCpuActivity) {
        reason = 'Idle MCP process waiting for requests';
      }
      if (detectedBy === 'mcp-client') {
        reason += ' · recognized as an agent by the MCP server it started';
      }

      // Pause holds the agents of this repository and what they started, nothing else:
      // not a dev server from the user's terminal, not an editor, not another session.
      const agentPid = nearestAgent(raw.pid);
      const pauseTarget =
        belongsToWatchedRepo &&
        (category === 'agent' || (agentPid !== undefined && belongsToRepo(agentPid)));
      // A held process uses no CPU by design: that is neither stale nor frozen
      const paused = this.paused.has(raw.pid);
      if (paused) {
        if (status === 'FROZEN' || status === 'STALE') status = 'IDLE';
        reason = 'Paused by agent-leash; resume continues it';
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
        cpuTimeSec,
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
        this.paused.delete(pid);
        this.alertedPids.delete(pid);
        this.cpuSamples.delete(pid);
      }
    }

    const processes = this.getProcesses();
    this.emit('scan-complete', processes);
    return processes;
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
    // A held process only acts on SIGTERM once it runs again
    if (this.paused.delete(pid)) this.processKiller(pid, 'SIGCONT');

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

  /** What `pause` would hold right now: the agents of the watched repository and what they started. */
  public getPauseTargets(): MonitoredProcess[] {
    return this.getProcesses().filter((proc) => proc.pauseTarget && !proc.paused);
  }

  /** PIDs agent-leash is holding right now. */
  public getPausedPids(): number[] {
    return Array.from(this.paused);
  }

  /**
   * Holds the pause targets with SIGSTOP. Nothing is terminated and nothing is lost: `resume`
   * continues every process where it stopped. A long autonomous run is paid work; an emergency
   * brake must not throw it away.
   */
  public pauseTargets(): number[] {
    const held: number[] = [];
    for (const proc of this.getPauseTargets()) {
      if (proc.pid === this.selfPid) continue;
      if (this.processKiller(proc.pid, 'SIGSTOP')) {
        this.paused.add(proc.pid);
        proc.paused = true;
        held.push(proc.pid);
      }
    }
    if (held.length > 0) this.emit('processes-paused', held);
    return held;
  }

  /** Continues every process agent-leash is holding (SIGCONT). */
  public resumePaused(): number[] {
    const resumed: number[] = [];
    for (const pid of Array.from(this.paused)) {
      this.paused.delete(pid);
      const proc = this.tracked.get(pid);
      if (proc) proc.paused = false;
      if (this.processKiller(pid, 'SIGCONT')) resumed.push(pid);
    }
    if (resumed.length > 0) this.emit('processes-resumed', resumed);
    return resumed;
  }


  private classifyProcess(
    raw: RawProcessInfo,
  ): { category: ProcessCategory; detectedBy?: AgentDetection } | null {
    const haystack = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();

    if (IGNORED_SYSTEM_PATTERNS.some((pat) => haystack.includes(pat))) {
      return null;
    }

    const detectedBy = this.agentByName(raw, haystack);
    if (detectedBy) {
      return { category: 'agent', detectedBy };
    }

    if (!TARGET_KEYWORDS.some((kw) => haystack.includes(kw))) {
      return null;
    }

    if (haystack.includes('mcp') || haystack.includes('modelcontextprotocol')) {
      return { category: 'mcp' };
    }

    if (haystack.includes('playwright')) {
      return { category: 'playwright' };
    }
    if (haystack.includes('chromium') || haystack.includes('headless_shell')) {
      return { category: 'chromium' };
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
      return { category: 'node' };
    }

    return null;
  }

  /** An agent recognized by its program name: a built-in name, or one from the `agents` setting. */
  private agentByName(raw: RawProcessInfo, haystack: string): AgentDetection | null {
    // Claude Code also runs as `node …/claude-code/cli.js` from npm or an editor extension
    if (
      haystack.includes('/claude-code/') ||
      haystack.includes('anthropic.claude-code') ||
      haystack.includes('/native-binary/claude')
    ) {
      return 'name';
    }
    const names = programNames(raw);
    if (names.some((name) => BUILT_IN_AGENT_NAMES.includes(name))) return 'name';
    if (names.some((name) => this.agentNames.has(name))) return 'setting';
    return null;
  }

  /**
   * The client that started an MCP server: its first ancestor that is not a launcher (shell, npm,
   * npx, uvx, ...) and not another MCP process. Undefined when that ancestor is an editor, a
   * desktop app or a terminal (never treated as an agent) or when the chain ends.
   */
  private findMcpClient(
    server: RawProcessInfo,
    rawByPid: Map<number, RawProcessInfo>,
    categoryOf: (pid: number) => ProcessCategory | undefined,
  ): number | undefined {
    let cur = server.ppid;
    for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
      const ancestor = rawByPid.get(cur);
      if (!ancestor) return undefined;
      const text = `${ancestor.name} ${ancestor.cmd ?? ''}`;
      if (HOST_PATTERNS.some(([pattern]) => pattern.test(text))) return undefined;
      if (IGNORED_SYSTEM_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern))) {
        return undefined;
      }
      const launcher = programNames(ancestor).some((name) => LAUNCHER_NAMES.has(name));
      if (!launcher && categoryOf(cur) !== 'mcp') return cur;
      cur = ancestor.ppid;
    }
    return undefined;
  }
}
