import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
 * Resolves the working directory (`cwd`) for a list of PIDs on macOS/Linux using `lsof`.
 */
async function resolveProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const cwdMap = new Map<number, string>();
  if (pids.length === 0) return cwdMap;

  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'],
      { timeout: 1500 },
    );
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
  } catch {
    // Ignore lsof errors on unsupported platforms or permission boundaries
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
    const { stdout } = await execFileAsync('ps', [
      '-Ao',
      'pid,ppid,rss,pcpu,pmem,etime,comm,args',
    ]);
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

export function defaultProcessKiller(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export class ProcessMonitor extends EventEmitter {
  private rootDir: string;
  private pollIntervalMs: number;
  private mcpSilenceTimeoutSec: number;
  private staleSessionSec: number;
  private agentActive: boolean;
  private selfPid: number;
  private isCustomLister: boolean;
  private processLister: () => Promise<RawProcessInfo[]>;
  private processKiller: (pid: number, signal?: NodeJS.Signals) => boolean;

  private timer: NodeJS.Timeout | null = null;
  private tracked: Map<number, MonitoredProcess> = new Map();
  private alertedPids: Set<number> = new Set();
  private lastFileActivityAt: number = Date.now();

  constructor(options: ProcessMonitorOptions = {}) {
    super();
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.mcpSilenceTimeoutSec = options.mcpSilenceTimeoutSec ?? 45;
    this.staleSessionSec = (options.staleSessionHours ?? 6) * 3600;
    this.agentActive = options.agentActive ?? true;
    this.selfPid = options.selfPid ?? process.pid;
    this.isCustomLister = Boolean(options.processLister);
    this.processLister = options.processLister ?? defaultProcessLister;
    this.processKiller = options.processKiller ?? defaultProcessKiller;
  }

  public start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
   */
  public async scan(now: number = Date.now()): Promise<MonitoredProcess[]> {
    const rawList = await this.processLister();
    const seenPids = new Set<number>();

    // Map all live PIDs, parent-child links, and parent PIDs that have children
    const allLivePids = new Set<number>();
    const parentByPid = new Map<number, number>();
    const parentPidsWithChildren = new Set<number>();
    for (const r of rawList) {
      allLivePids.add(r.pid);
      if (r.ppid) {
        parentByPid.set(r.pid, r.ppid);
        parentPidsWithChildren.add(r.ppid);
      }
    }

    const candidates: Array<{ raw: RawProcessInfo; category: ProcessCategory }> = [];
    for (const raw of rawList) {
      if (raw.pid === this.selfPid) continue;
      const cmdLower = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      // Skip `npm exec` wrapper parents when their actual node child process is running
      if (cmdLower.includes('npm exec ') && parentPidsWithChildren.has(raw.pid)) {
        continue;
      }
      const category = this.classifyProcess(raw);
      if (!category) continue;
      candidates.push({ raw, category });
    }

    const cwdMap = this.isCustomLister
      ? new Map<number, string>()
      : await resolveProcessCwds(candidates.map((c) => c.raw.pid));
    const homeDir = os.homedir();

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

      const isInWatchedRepo =
        typeof rawCwd === 'string' &&
        rawCwd.length > 0 &&
        (path.resolve(rawCwd) === this.rootDir ||
          path.resolve(rawCwd).startsWith(this.rootDir + path.sep));

      const isOtherRepo =
        typeof rawCwd === 'string' && rawCwd.length > 0 && !isInWatchedRepo;

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
        reason = `Old session in ${displayCwd} (${formattedUptime}) — safe to kill`;
      } else if (!isInWatchedRepo && !rawCwd && isStaleByAge && cpu < 0.5 && category === 'mcp') {
        // Detached MCP process without a repository cwd that has been sitting around for >6h
        status = 'STALE';
        safety = 'safe-to-kill';
        reason = `Stale detached MCP process (${formattedUptime} old) — safe to kill`;
      } else if (isOrphaned && !hasCpuActivity && elapsedSec >= this.mcpSilenceTimeoutSec) {
        status = 'FROZEN';
        safety = 'safe-to-kill';
        reason = `Orphaned process (PPID=1, ${formattedUptime}) — safe to kill`;
      } else if (
        category === 'mcp' &&
        !hasCpuActivity &&
        hasLiveParentChain &&
        !this.isCustomLister
      ) {
        // Real-world MCP child server whose parent agent session is alive in the current repo:
        // 0% CPU is normal standby behavior waiting for stdin tool requests, regardless of session age!
        status = 'STANDBY';
        safety = 'standby-mcp';
        reason = `Standby MCP child (PPID ${raw.ppid} alive, age ${formattedUptime}) — waiting for tool call`;
      } else if (
        isInWatchedRepo &&
        category === 'agent' &&
        !this.isCustomLister
      ) {
        // Active agent session in the currently watched repository is NEVER marked stale just because
        // the developer has been working in the repo for >6 hours!
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

  public killProcess(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
    if (pid === this.selfPid) return false;
    const killed = this.processKiller(pid, signal);
    if (killed) {
      const proc = this.tracked.get(pid);
      this.tracked.delete(pid);
      this.alertedPids.delete(pid);
      this.emit('process-killed', { pid, process: proc });
    }
    return killed;
  }

  public killAllMonitored(onlySafeToKill: boolean = false): number[] {
    const killedPids: number[] = [];
    for (const proc of Array.from(this.tracked.values())) {
      if (
        onlySafeToKill &&
        proc.status !== 'FROZEN' &&
        proc.status !== 'STALE' &&
        proc.safety !== 'safe-to-kill'
      ) {
        continue;
      }
      if (this.killProcess(proc.pid)) {
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
