import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessHealthStatus = 'ACTIVE' | 'IDLE' | 'STANDBY' | 'STALE' | 'FROZEN';
/**
 * A coding agent, an MCP server, or a process an agent started and is still running (a dev
 * server, a test watcher, a browser): `child` is decided by the process tree, never by name.
 */
export type ProcessCategory = 'agent' | 'mcp' | 'child';
/**
 * Where a memory value comes from. `footprint` is the physical footprint, what Activity Monitor
 * shows as Memory. `rss` stands in where it cannot be read: it counts shared pages in full and
 * misses compressed memory (an idle MCP server showed 12 KB RSS and 24 MB footprint), so it is
 * shown as approximate.
 */
export type MemorySource = 'footprint' | 'rss';
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
  /** Memory in MB: the physical footprint where it can be read, otherwise RSS (see `memorySource`). */
  memoryMb: number;
  memorySource: MemorySource;
  uptime: string;
  elapsedSec: number;
  /** When it started (ms, scan clock): its age at the scan that listed it, taken from that scan's time. */
  startedAt: number;
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
  /** Held with SIGSTOP by strayps; `resume` continues it where it stopped. */
  paused: boolean;
  /** Application the process tree hangs off (VS Code, Claude Desktop, a terminal, ...), if recognizable. */
  host?: string;
  /** Only for agents: how the process was recognized as one. */
  detectedBy?: AgentDetection;
  /** The nearest monitored agent this process was started by, directly or through launchers. */
  agentPid?: number;
}

/**
 * A process `pause` would hold. Besides the listed pause targets these are the processes the
 * agents of this repository run right now and that are not listed: the shell around a tool call,
 * a call younger than the listing threshold. They are held too, and listed while they are held.
 */
export interface PauseTarget {
  pid: number;
  /** Readable command line, secrets redacted; untrusted text. */
  cmd: string;
  category: ProcessCategory;
  cwd?: string;
  /** False for a process the list does not show (yet). */
  listed: boolean;
  /** For a listed process: when strayps first saw it; the same process keeps it from scan to scan. */
  firstSeenAt?: number;
  /**
   * When it started (ms, scan clock), from its age and the time of the scan that saw it: tells
   * the process a person confirmed from a newer one under the same PID. Undefined when unknown.
   */
  startedAt?: number;
  /** Its age in seconds at that scan; a process under this PID now must not be younger. */
  elapsedSec?: number;
}

/** What `pauseTargets` did with the confirmed list. */
export interface PauseOutcome {
  /** Held now (SIGSTOP). */
  pids: number[];
  /** Confirmed, but gone, or the PID names another process now: not held. */
  gone: number[];
  /**
   * Pause targets of the last scan that the confirmation did not show and that are not held: a new
   * agent, what a new agent runs, what an agent runs that was not confirmed.
   */
  notAsked: number[];
  /**
   * Held although the confirmation did not show them: what the confirmed agents started while the
   * question was open (also in `pids`). Never an agent.
   */
  alsoHeld: number[];
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
  // login: Terminal.app and Ghostty start the shell through it, and an MCP server run by hand in
  // such a tab made login an agent (review, 20.11.2026)
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'nohup', 'timeout', 'login',
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
    const script = interpreterScript(args);
    if (script) names.add(script.module ? baseName(script.path) : stripScriptExtension(baseName(script.path)));
  }
  return Array.from(names);
}

/** The script (or `-m` module) an interpreter runs, from its arguments. */
function interpreterScript(args: string[]): { path: string; module: boolean } | undefined {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (INLINE_CODE_OPTIONS.has(arg)) return undefined;
    if (arg === '-m') return args[i + 1] ? { path: args[i + 1], module: true } : undefined;
    if (OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { path: arg, module: false };
  }
  return undefined;
}

/**
 * What a process is, for the host patterns: its executable and, for an interpreter, its script.
 * Never its other arguments: agy, started by the Antigravity IDE with "antigravity" in its
 * arguments, was taken for the IDE and so for no agent at all (scenario pass, 20.11.2026).
 */
function programIdentity(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): string {
  const args = (raw.cmd ?? '').trim().split(/\s+/).filter(Boolean);
  // On macOS `name` is the full path of the executable (ps comm), spaces included
  const parts = [raw.name, args[0] ?? ''];
  if (INTERPRETER.test(baseName(args[0] ?? '')) || INTERPRETER.test(baseName(raw.name))) {
    const script = interpreterScript(args);
    if (script) parts.push(script.path);
  }
  return parts.join(' ');
}

const MCP_KEYWORDS = ['mcp', 'modelcontextprotocol'];

/** "125.0 MB", or "~125.0 MB" when the value is RSS and so only approximate. */
export function formatMemory(mb: number, approximate: boolean, digits = 1): string {
  return `${approximate ? '~' : ''}${mb.toFixed(digits)} MB`;
}

/** Memory of several processes together: approximate as soon as one value is. */
export function sumMemory(processes: Array<Pick<MonitoredProcess, 'memoryMb' | 'memorySource'>>, digits = 0): string {
  const mb = processes.reduce((sum, p) => sum + (p.memoryMb || 0), 0);
  return formatMemory(mb, processes.some((p) => p.memorySource !== 'footprint'), digits);
}

/** How often the physical footprint is read: `footprint` takes about a second for 30 processes. */
export const MEMORY_READ_INTERVAL_MS = 15_000;

/**
 * Programs by full path on macOS, where their place is fixed: found through PATH, a `ps` or
 * `footprint` in the repository's node_modules/.bin (first in PATH under npx and npm scripts)
 * would have run instead (review, 20.11.2026). Linux keeps the PATH lookup, its paths vary.
 */
const IS_MAC = process.platform === 'darwin';
export const PS_BIN = IS_MAC ? '/bin/ps' : 'ps';
const LSOF_BIN = IS_MAC ? '/usr/sbin/lsof' : 'lsof';
const FOOTPRINT_BIN = '/usr/bin/footprint';

/**
 * Footprint per requested PID from `footprint -f bytes -j` output: `auxiliary.phys_footprint`
 * (what Activity Monitor shows), or the process's `footprint` when that is missing. JSON, not the
 * text output: there each block starts with the process's own name, and a name can imitate the
 * header of another PID (review, 20.11.2026).
 */
export function parseFootprintJson(data: unknown, pids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (!data || typeof data !== 'object') return result;
  const { processes, 'bytes per unit': perUnit } = data as { processes?: unknown; 'bytes per unit'?: unknown };
  if (!Array.isArray(processes)) return result;
  const factor = typeof perUnit === 'number' && perUnit > 0 ? perUnit : 1;
  const requested = new Set(pids);
  for (const entry of processes) {
    if (!entry || typeof entry !== 'object') continue;
    const { pid, footprint, auxiliary } = entry as { pid?: unknown; footprint?: unknown; auxiliary?: unknown };
    if (typeof pid !== 'number' || !requested.has(pid)) continue;
    const phys = auxiliary && typeof auxiliary === 'object' ? (auxiliary as { phys_footprint?: unknown }).phys_footprint : undefined;
    const units = typeof phys === 'number' ? phys : typeof footprint === 'number' ? footprint : undefined;
    if (units !== undefined && Number.isFinite(units) && units >= 0) result.set(pid, units * factor);
  }
  return result;
}

/**
 * Reads the physical footprint with macOS `footprint`. It only reads, needs no root for one's own
 * processes, and does not stop them (measured on 20.11.2026: largest timer gap 2 ms in a process
 * it read five times; only `--forkCorpse`, not used, stopped it for 270 ms). Its JSON goes into a
 * private temporary directory, removed right after.
 */
async function readFootprints(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'strayps-footprint-'));
  const jsonPath = path.join(dir, 'footprint.json');
  try {
    try {
      await execFileAsync(FOOTPRINT_BIN, ['-f', 'bytes', '-j', jsonPath, ...pids.flatMap((pid) => ['-p', String(pid)])], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      // A PID that is gone or belongs to another user makes it fail; the file still holds the others
    }
    let text: string;
    try {
      text = await fs.promises.readFile(jsonPath, 'utf8');
    } catch {
      return new Map();
    }
    try {
      return parseFootprintJson(JSON.parse(text), pids);
    } catch {
      return new Map();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
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

/** Editors and terminals by their exact program name, where no app bundle says it (Linux, tmux, sshd). */
const APP_PROGRAM_NAMES = new Set([
  'tmux',
  'sshd',
  'kitty',
  'alacritty',
  'xterm',
  'wezterm',
  'wezterm-gui',
  'ghostty',
  'konsole',
  'gnome-terminal',
  'gnome-terminal-server',
  'code',
  'code-insiders',
  'codium',
  'cursor',
  'windsurf',
  'zed',
  'antigravity',
]);

/**
 * The app bundles of editors, IDEs, desktop apps that run agents, and terminals, by name (a closed
 * list: an app missing here is treated like any other program): their own programs (`Contents/MacOS/`, and helper apps under `Contents/Frameworks/`). Not any program in an
 * app bundle: framework Python runs as `Python.app/Contents/MacOS/Python`, and the Chrome or the
 * Electron app an agent drives are apps too (safety review, 22.11.2026).
 */
const APP_BUNDLE_PROGRAM =
  /\/(?:Visual Studio Code(?: - Insiders)?|VSCodium|Cursor|Windsurf|Kiro|Trae|Positron|Void|Zed(?: Preview)?|Antigravity|Claude|Xcode|Sublime Text|Nova|BBEdit|TextMate|MacVim|Emacs|Fleet|Android Studio|IntelliJ IDEA[^/]*|WebStorm|PyCharm[^/]*|GoLand|PhpStorm|RubyMine|CLion|RustRover|DataGrip|Rider|Terminal|iTerm2?|Warp|Ghostty|kitty|Alacritty|WezTerm|Hyper|Tabby|Wave|Rio)\.app\/Contents\/(?:MacOS\/|Frameworks\/[^/]+\.app\/Contents\/MacOS\/)/i;

/**
 * An editor, desktop app or terminal, which pause never holds, decided by the program file alone:
 * a program of one of APP_BUNDLE_PROGRAM's bundles, or one of APP_PROGRAM_NAMES. Not by
 * HOST_PATTERNS, which find a word anywhere in the path: in ~/WebstormProjects every tool call
 * looked like the IDE and was neither held nor named; nor by an install directory, where a build
 * can run the IDE's Java (safety review, 22.11.2026).
 */
function isAppOrTerminal(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): boolean {
  const files = [raw.name, (raw.cmd ?? '').trim().split(/\s+/)[0] ?? ''];
  return files.some(
    (file) =>
      APP_BUNDLE_PROGRAM.test(file) ||
      APP_PROGRAM_NAMES.has(baseName(file).toLowerCase().replace(/:.*$/, '')),
  );
}

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
 * A session in another repository is called stale only after strayps has watched it for this
 * long, it started no new process in that window, and it used less than STALE_CPU_BUDGET_SEC of
 * CPU time in it. A freshly started strayps therefore calls nothing stale for this long.
 */
export const STALE_QUIET_SEC = 10 * 60;
/**
 * Idle is not zero. Measured on 20.11.2026 over 25 minutes, per 10 minutes: idle agy 0.8 to
 * 1.0 s, idle claude in a terminal 1.4 to 5.5 s, idle claude in Claude Desktop 4.6 to 6.5 s; working
 * claude 4.2 to 19.5 s. CPU time alone overlaps, so the main sign of work is a new child process
 * (a tool call: a shell, git, rg, tests), which no idle session started; this budget only catches
 * an agent that works for 10 minutes without starting anything.
 */
export const STALE_CPU_BUDGET_SEC = 8;
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
      LSOF_BIN,
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

// Secret redaction. Every pattern below either starts at a fixed literal or at the start of a word
// and has a bounded name, so its cost grows with the length of the command line, not its square:
// unbounded, one argument of 50,000 letters held each scan for 2.7 s (external audit, 21.11.2026),
// and a command line can be 1 MB on macOS.
const SECRET_WORD = /token|secret|passw(?:or)?d|pwd|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|bearer/i;
const KEY_SUFFIX = /(?:^|[-_])key$/i;
/** Longer names are not taken for secret names; the bound keeps the patterns linear. */
const MAX_SECRET_NAME = 64;
/** How many words a quoted value may span (`sh -c 'x --token "a b"'` shows the quotes). */
const MAX_QUOTED_WORDS = 16;
// --token VALUE, --api-key=VALUE, -key VALUE; --no-auth is a switch without a value
const SECRET_FLAG = /^(--(?!no-)|-(?!-))([A-Za-z0-9_.-]{1,64})(?:=([\s\S]*))?$/i;
// API_KEY=VALUE as a word of its own
const SECRET_VAR = /^([A-Za-z0-9_.-]{1,64})=([\s\S]*)$/;
// a header name and its colon where a word or a list item starts: "x-api-key:", "{Authorization :",
// "Accept:json,Authorization:Basic ..."
const HEADER_NAME = /(?<=^|[\s"'=,;{(\[:])([A-Za-z0-9_-]{1,64})[ \t]*:/g;
// what follows the colon and stays: spaces and a scheme
const HEADER_PREFIX = /[ \t]*(?:(?:bearer|token|basic)[ \t]+)?/iy;
// the value: quoted, or plain up to a space, a quote or the end of a list item
const HEADER_VALUE = /"[^"]*"|'[^']*'|["']?[^\s"',;)}\]]+/y;
// JSON: {"x-api-key":"VALUE"}
const SECRET_JSON = /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
// query parameters: ?api_key=VALUE&token=VALUE
const SECRET_QUERY = /([?&])([A-Za-z0-9_.-]{1,64})=([^\s&#"']+)/g;
// whatever stands between "://" and "@": user:password (which may hold ? and #), or a token alone.
// It starts at "://", not at the scheme, which may be long or follow a letter (-ihttps://...)
const URL_USERINFO = /:\/\/(?:[^\s/@:]*:[^\s/@]*|[^\s/?#@:]+)@/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// well-known token formats anywhere: GitHub, OpenAI/Anthropic/Stripe (sk-), Slack, Google, AWS, npm, GitLab
const TOKEN_FORMATS =
  /\b(?:(?:ghp|gho|ghs|ghu|ghr|github_pat|sk|xox[abprs])[-_][A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|npm_[A-Za-z0-9]{30,}|glpat-[0-9A-Za-z_-]{20,})/g;

/**
 * The home directory as strayps compares it: HOME=/Users/x/ names the same directory as /Users/x.
 * With the slash, an agent started in the home directory was not seen as working there, and its
 * kill plan took along the other agents started there (safety review, 21.11.2026).
 */
export function homeDirectory(): string {
  return os.homedir().replace(/\/+$/, '');
}

function isSecretName(name: string): boolean {
  return name.length <= MAX_SECRET_NAME && (SECRET_WORD.test(name) || KEY_SUFFIX.test(name));
}

/**
 * Replaces secrets in a command line with [redacted]: values of flags, variables, headers, query
 * parameters and JSON keys named like a token, key, secret or password, credentials in URLs, and
 * well-known token formats. Command lines come from every process on the machine and are shown in
 * the terminal, the dashboard and /api/status, where they end up in screenshots and logs.
 * Recognition always uses the original command line.
 *
 * `ps` joins the arguments with spaces and drops the quotes the shell removed: a value with spaces
 * that was one argument cannot be told from several, and only its first word is redacted. Where the
 * quotes are part of the argument (a command for `sh -c`), the value is redacted up to its closing
 * quote.
 */
export function redactSecrets(cmd: string): string {
  return redactHeaders(redactArguments(cmd))
    .replace(SECRET_JSON, (match, name: string, colon: string) =>
      isSecretName(name) ? `"${name}"${colon}"[redacted]"` : match,
    )
    .replace(SECRET_QUERY, (match, sep: string, name: string) => (isSecretName(name) ? `${sep}${name}=[redacted]` : match))
    .replace(URL_USERINFO, '://[redacted]@')
    .replace(BEARER, '$1 [redacted]')
    .replace(TOKEN_FORMATS, '[redacted]');
}

/**
 * Header values. A header with a harmless name gives up only its name: in "Accept:json,Authorization:
 * Basic ..." the value of Accept must not swallow the header after it (safety review, 21.11.2026).
 */
function redactHeaders(text: string): string {
  let out = '';
  let copied = 0;
  HEADER_NAME.lastIndex = 0;
  for (let name = HEADER_NAME.exec(text); name; name = HEADER_NAME.exec(text)) {
    if (!isSecretName(name[1])) continue;
    HEADER_PREFIX.lastIndex = HEADER_NAME.lastIndex;
    HEADER_PREFIX.exec(text);
    const start = HEADER_PREFIX.lastIndex;
    // "x-api-key: a b" in quotes that are part of the argument (sh -c): up to the closing quote
    const opened = text[name.index - 1];
    let end = opened === '"' || opened === "'" ? text.indexOf(opened, start) : -1;
    let replacement = '[redacted]';
    if (end === -1) {
      HEADER_VALUE.lastIndex = start;
      const value = HEADER_VALUE.exec(text);
      if (!value) continue;
      end = HEADER_VALUE.lastIndex;
      const quote = value[0][0] === '"' || value[0][0] === "'" ? value[0][0] : '';
      const closed = quote !== '' && value[0].length > 1 && value[0].endsWith(quote);
      replacement = `${quote}[redacted]${closed ? quote : ''}`;
    } else if (end === start) {
      continue;
    }
    out += `${text.slice(copied, start)}${replacement}`;
    copied = end;
    // on after the value: a name inside it was redacted with it
    HEADER_NAME.lastIndex = end;
  }
  return out + text.slice(copied);
}

/** Flags and variables, word by word: only where a word starts, never inside a path. */
function redactArguments(cmd: string): string {
  // even indexes: the words; odd indexes: the whitespace between them
  const parts = cmd.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const flag = SECRET_FLAG.exec(parts[i]);
    if (flag && isSecretName(flag[2])) {
      if (flag[3] !== undefined) {
        if (flag[3] === '') continue;
        parts[i] = `${flag[1]}${flag[2]}=[redacted]`;
        i = redactQuotedRest(parts, i, flag[3]);
      } else if (i + 2 < parts.length && parts[i + 2] !== '' && !parts[i + 2].startsWith('-')) {
        // the next word is the value, unless it is another flag
        i += 2;
        const value = parts[i];
        parts[i] = '[redacted]';
        i = redactQuotedRest(parts, i, value);
      }
      continue;
    }
    const variable = SECRET_VAR.exec(parts[i]);
    if (variable && variable[2] !== '' && isSecretName(variable[1])) {
      parts[i] = `${variable[1]}=[redacted]`;
      i = redactQuotedRest(parts, i, variable[2]);
    }
  }
  return parts.join('');
}

/**
 * A value that opens a quote and does not close it in the same word goes on up to the word with
 * the closing quote: those words go too. Returns the index of the last word redacted.
 */
function redactQuotedRest(parts: string[], i: number, value: string): number {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return i;
  if (value.length > 1 && value.indexOf(quote, 1) !== -1) return i;
  for (let j = i + 2; j < parts.length && j <= i + 2 * MAX_QUOTED_WORDS; j += 2) {
    if (parts[j].includes(quote)) {
      for (let k = i + 1; k <= j; k++) parts[k] = '';
      return j;
    }
  }
  return i;
}

/**
 * Redacted first, shortened after: cut first, a URL lost its "@" and a token its length, and the
 * visible part of a secret was shown (external audit, 21.11.2026).
 */
function formatReadableCmd(rawName: string, rawCmd: string): string {
  return readableCmd(rawName, redactSecrets(rawCmd));
}

function readableCmd(rawName: string, rawCmd: string): string {
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
 * Turns the output of `ps -Ao pid,ppid,pgid,rss,pcpu,pmem,etime,time,args` and of `ps -Ao pid,comm`
 * into process records. `comm` comes from its own call, where it is the last column: on macOS it is
 * the full program path, which can contain spaces ("Application Support"), and in the middle of a
 * line it shifted every column after it into the wrong field.
 */
export function parsePsOutput(main: string, comm: string): RawProcessInfo[] {
  const commByPid = new Map<number, string>();
  for (const line of comm.split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) commByPid.set(Number(match[1]), match[2]);
  }
  const results: RawProcessInfo[] = [];
  for (const line of main.trim().split('\n').slice(1)) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cmd = match[9];
    results.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssKb: Number(match[4]) || 0,
      cpu: Number(match[5]) || 0,
      memory: Number(match[6]) || 0,
      etime: match[7],
      cpuTimeSec: parseCpuTime(match[8]),
      name: commByPid.get(pid) ?? cmd.split(/\s+/)[0] ?? '',
      cmd,
    });
  }
  return results;
}

/**
 * Numbers from `ps` in one format: under de_DE, macOS ps writes "0,0", and those lines were dropped.
 * Only the number format is fixed; the character set stays the user's, so paths with umlauts stay
 * readable. LC_ALL would override LC_NUMERIC, so its value moves to LC_CTYPE.
 */
function psEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_NUMERIC: 'C' };
  const ctype = env.LC_ALL || env.LC_CTYPE || env.LANG;
  delete env.LC_ALL;
  if (ctype) env.LC_CTYPE = ctype;
  return env;
}

/**
 * Default OS process lister using POSIX `ps` (with RSS in KB and elapsed uptime) and `ps-list` fallback.
 */
export async function defaultProcessLister(): Promise<RawProcessInfo[]> {
  try {
    const options = { maxBuffer: 16 * 1024 * 1024, env: psEnvironment() };
    const [main, comm] = await Promise.all([
      execFileAsync(PS_BIN, ['-Ao', 'pid,ppid,pgid,rss,pcpu,pmem,etime,time,args'], options),
      execFileAsync(PS_BIN, ['-Ao', 'pid,comm'], options),
    ]);
    return parsePsOutput(main.stdout, comm.stdout);
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

/**
 * The process table as `defaultProcessLister` reads it, but synchronously: pause reads it while the
 * agents it just held wait, and the answer to the question runs synchronously in both front ends.
 */
export function defaultProcessTree(): RawProcessInfo[] | undefined {
  try {
    const options = {
      encoding: 'utf-8' as const,
      maxBuffer: 16 * 1024 * 1024,
      env: psEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'] as Array<'ignore' | 'pipe'>,
      timeout: 1000,
    };
    const main = execFileSync(PS_BIN, ['-Ao', 'pid,ppid,pgid,rss,pcpu,pmem,etime,time,args'], options);
    const comm = execFileSync(PS_BIN, ['-Ao', 'pid,comm'], options);
    return parsePsOutput(main, comm);
  } catch {
    return undefined;
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

/** Seconds since `pid` started, from `ps -o etime=`; undefined when it cannot be read. */
export function defaultProcessAge(pid: number): number | undefined {
  try {
    const etime = execFileSync(PS_BIN, ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: { ...process.env, LC_NUMERIC: 'C' },
    }).trim();
    return etime ? parseElapsedTime(etime).elapsedSec : undefined;
  } catch {
    return undefined;
  }
}

/** Seconds since each PID started, from one `ps -o pid=,etime=` call; unknown ones are left out. */
export function defaultProcessAges(pids: number[]): Map<number, number> {
  const ages = new Map<number, number>();
  if (pids.length === 0) return ages;
  let out: string;
  try {
    out = execFileSync(PS_BIN, ['-o', 'pid=,etime=', '-p', pids.join(',')], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: { ...process.env, LC_NUMERIC: 'C' },
    });
  } catch (err) {
    // ps exits 1 when one of the PIDs is gone, and still prints the others: dropping them switched
    // the age check off for all (safety review, 21.11.2026)
    const stdout = (err as { stdout?: unknown }).stdout;
    out = typeof stdout === 'string' ? stdout : '';
  }
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (match && pids.includes(Number(match[1]))) ages.set(Number(match[1]), parseElapsedTime(match[2]).elapsedSec);
  }
  return ages;
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
  private processAge: (pid: number) => number | undefined;
  private processAges: (pids: number[]) => Map<number, number>;
  private processTree: () => RawProcessInfo[] | undefined;
  private cwdResolver: (pids: number[]) => Promise<Map<number, string>>;
  private agentNames: Set<string> = new Set();

  private timer: NodeJS.Timeout | null = null;
  private tracked: Map<number, MonitoredProcess> = new Map();
  private paused: Set<number> = new Set();
  /** For each held PID: its age and the scan time when it was held, to tell a reused PID. */
  private heldSince: Map<number, { elapsedSec: number; at: number }> = new Map();
  /** Counts every SIGSTOP; per held PID the count at its hold, to tell holds newer than a scan's list. */
  private holdCount = 0;
  private holdNumber: Map<number, number> = new Map();
  /** Unlisted processes the agents of this repository run, as of the last scan (see PauseTarget). */
  private pauseExtras: Map<number, { raw: RawProcessInfo; elapsedSec?: number; startedAt?: number }> = new Map();
  private lastScanAt = 0;
  /** `Date.now()` when the last scan started: converts a time read now to the scan clock (tests inject one). */
  private lastScanWallAt = 0;
  /** Every process the last finished scan saw, and that scan's time: what pause falls back to. */
  private lastTree: { at: number; raws: RawProcessInfo[] } = { at: 0, raws: [] };
  /** Parent of every process of the last scan, listed or not (shells and npx are not listed). */
  private lastParentByPid: Map<number, number> = new Map();
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

  private async performScan(now: number): Promise<MonitoredProcess[]> {
    this.lastScanAt = now;
    const wallAtStart = Date.now();
    this.lastScanWallAt = wallAtStart;
    // pause can answer while this scan waits for lsof or footprint, and hold processes this list
    // does not have yet: they must not be forgotten when the scan goes on (safety review, 22.11.2026)
    const holdsBeforeList = this.holdCount;
    const heldAfterList = (pid: number): boolean => (this.holdNumber.get(pid) ?? 0) > holdsBeforeList;
    const rawList = await this.processLister();
    // When ps had read the ages, on the scan clock. Ages taken as of the scan's start made a slow ps
    // look like a reused PID: a confirmed agent "gone", a held process forgotten while still stopped
    // (safety review, 22.11.2026). Later is the safe side: it only lowers the age expected later.
    const listedAt = now + (Date.now() - wallAtStart);
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

    // The chain of processes that launched strayps (npm, tsx, npx wrappers, the shell).
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
      // Wrappers that started strayps itself are not agent work; killing them would kill us.
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

    // What an agent started and is still running: a dev server, a test watcher, a browser its MCP
    // server opened. Decided by the process tree alone: "node", "chromium" or "playwright" in a
    // command line listed the user's own servers and apps as well (cut on 20.11.2026).
    const agentAbove = (pid: number): boolean => {
      let cur = parentByPid.get(pid);
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        // its own subtree: what it runs is no work of the agent that started it
        if (cur === this.selfPid) return false;
        if (candidateByPid.get(cur)?.category === 'agent') return true;
        cur = parentByPid.get(cur);
      }
      return false;
    };
    for (const raw of rawList) {
      if (candidateByPid.has(raw.pid) || raw.pid === this.selfPid || this.terminating.has(raw.pid)) continue;
      // The wrappers that started strayps: ending the agent's session must not end strayps
      if (selfAncestors.has(raw.pid)) continue;
      // A held process stays in view until it is continued or gone, wherever it is in the tree now:
      // a held browser whose MCP server was ended moved to PID 1, left the list and the set of held
      // processes, and stayed stopped for good (review, 20.11.2026)
      if (this.stillHeld(raw, now, heldAfterList(raw.pid))) {
        const held: Candidate = { raw, category: this.tracked.get(raw.pid)?.category ?? 'child' };
        candidates.push(held);
        candidateByPid.set(raw.pid, held);
        continue;
      }
      if (!agentAbove(raw.pid)) continue;
      // Without a known age a tool call cannot be told from a server
      if (raw.etime === undefined || parseElapsedTime(raw.etime).elapsedSec < CHILD_MIN_AGE_SEC) continue;
      const text = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();
      if (IGNORED_SYSTEM_PATTERNS.some((pattern) => text.includes(pattern))) continue;
      // A shell or npm with a process under it only wraps that process
      if (parentPidsWithChildren.has(raw.pid) && programNames(raw).some((name) => LAUNCHER_NAMES.has(name))) {
        continue;
      }
      const child: Candidate = { raw, category: 'child' };
      candidates.push(child);
      candidateByPid.set(raw.pid, child);
    }

    // Descendants of every candidate, for "did it start a process?". its own subtree is
    // left out: its ps calls would make the agent that started it look busy forever.
    const descendantsOf = new Map<number, number[]>();
    for (const r of rawList) {
      if (r.pid === this.selfPid) continue;
      const chain: number[] = [];
      let underSelf = false;
      for (let cur = r.ppid, depth = 0; cur && cur > 1 && depth < 32; depth++) {
        if (cur === this.selfPid) {
          underSelf = true;
          break;
        }
        chain.push(cur);
        cur = parentByPid.get(cur);
      }
      if (underSelf) continue;
      for (const ancestor of chain) {
        if (!candidateByPid.has(ancestor)) continue;
        const list = descendantsOf.get(ancestor);
        if (list) list.push(r.pid);
        else descendantsOf.set(ancestor, [r.pid]);
      }
    }

    // An editor, desktop app or terminal an agent started is never held, nor what runs in it
    // (safety review, 22.11.2026)
    const hostOnTheWay = (pid: number, agent: number | undefined): boolean => {
      for (let cur: number | undefined = pid, depth = 0; cur && cur > 1 && cur !== agent && depth < 32; depth++) {
        const raw = rawByPid.get(cur);
        if (raw && isAppOrTerminal(raw)) return true;
        cur = parentByPid.get(cur);
      }
      return false;
    };

    const nearestAgent = (pid: number): number | undefined => {
      let cur = parentByPid.get(pid);
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        if (candidateByPid.get(cur)?.category === 'agent') return cur;
        cur = parentByPid.get(cur);
      }
      return undefined;
    };

    const cwdMap = await this.cwdResolver(candidates.map((c) => c.raw.pid));

    // A value of a PID that is not listed any more must not end up on a new process with that PID
    for (const pid of this.footprints.keys()) {
      if (!candidateByPid.has(pid)) this.footprints.delete(pid);
    }
    if (this.memoryReader && now - this.lastMemoryReadAt >= MEMORY_READ_INTERVAL_MS) {
      this.lastMemoryReadAt = now;
      try {
        this.footprints = await this.memoryReader(candidates.map((c) => c.raw.pid));
      } catch (err) {
        // No footprint tool on this system: RSS from now on. Any other failure: RSS until the next read.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.memoryReader = undefined;
        this.footprints = new Map();
      }
    }
    const homeDir = homeDirectory();

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
        const identity = programIdentity(ancestor);
        for (const [pattern, label] of HOST_PATTERNS) {
          if (pattern.test(identity)) return label;
        }
        cur = ancestor.ppid;
      }
      return undefined;
    };

    for (const { raw, category, detectedBy } of candidates) {
      // Ended while this scan waited for working directories or memory: it must not come back
      // with a new firstSeenAt, to be ended a second time (review, 20.11.2026)
      if (this.terminating.has(raw.pid)) continue;
      seenPids.add(raw.pid);
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
      const lastNewChildAt = this.trackChildren(raw.pid, descendantsOf.get(raw.pid) ?? [], now, reusedPid);
      const startedProcessRecently =
        lastNewChildAt !== undefined && now - lastNewChildAt < this.staleQuietSec * 1000;
      const quietLongEnough =
        usedInWindowSec !== undefined && usedInWindowSec < STALE_CPU_BUDGET_SEC && !startedProcessRecently;
      const idleNote = `idle: no new process and ${formatCpu(usedInWindowSec ?? 0)} CPU time in the last ${formatDuration(this.staleQuietSec)}`;
      const lastActiveAt = existing && !hasCpuActivity ? existing.lastActiveAt : now;

      const silenceSec = Math.max(0, Math.floor((now - lastActiveAt) / 1000));
      const { elapsedSec, formattedUptime } = raw.etime
        ? parseElapsedTime(raw.etime)
        : { elapsedSec: silenceSec, formattedUptime: `${silenceSec}s` };

      const rawCwd = raw.cwd ?? cwdMap.get(raw.pid);
      // Only the home directory and what is inside it: /Users/uj-backup is not ~-backup
      const displayCwd = rawCwd
        ? homeDir.length > 1 && (rawCwd === homeDir || rawCwd.startsWith(`${homeDir}/`))
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
      // The default when no rule below says more: where the process works, never a claim that it
      // is in the watched repository when it is not
      let reason = isOtherRepo
        ? `Session in ${displayCwd} (open for ${formattedUptime})${hostNote}`
        : belongsToWatchedRepo
          ? 'Active in current repository'
          : `Running for ${formattedUptime}${hostNote}`;

      if (!isOtherRepo && isDevServer) {
        status = 'ACTIVE';
        reason = `Running dev server in current repository (${formattedUptime})`;
      } else if (isOtherRepo && isStaleByAge && quietLongEnough) {
        // Age alone called sessions stale that were still in use at an open editor:
        // a session in another repository is stale only when it is old AND has used no CPU time
        // for a measured window.
        status = 'STALE';
        reason = `Session in ${displayCwd}, running for ${formattedUptime}, ${idleNote}${hostNote}`;
      } else if (isOtherRepo && isStaleByAge) {
        reason =
          cpuTimeSec === undefined
            ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; its CPU time cannot be read, so it is never called stale`
            : usedInWindowSec === undefined
              ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; watching for ${formatDuration(this.staleQuietSec)} whether it is still in use`
              : startedProcessRecently
                ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; in use: started a process ${formatDuration(Math.floor((now - lastNewChildAt!) / 1000))} ago`
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
        reason = `MCP process without a working directory, running for ${formattedUptime}, ${idleNote}${hostNote}`;
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
        // waiting for its user were all called FROZEN after 45 s. Only a process
        // whose parent is gone (rule above) is called frozen.
        reason = `Quiet: no CPU activity for ${silenceSec}s`;
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
        (category === 'agent' ||
          (agentPid !== undefined && belongsToRepo(agentPid) && !hostOnTheWay(raw.pid, agentPid)));
      // A held process uses no CPU by design: that is neither stale nor frozen
      const paused = this.paused.has(raw.pid);
      if (paused) {
        if (status === 'FROZEN' || status === 'STALE') status = 'IDLE';
        reason = 'Paused by strayps; resume continues it';
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
        memorySource,
        uptime: formattedUptime,
        elapsedSec,
        startedAt: listedAt - elapsedSec * 1000,
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
        if (!heldAfterList(pid)) this.forgetHold(pid);
        this.alertedPids.delete(pid);
        this.cpuSamples.delete(pid);
        this.children.delete(pid);
      }
    }

    // Held PIDs that never made it into the list and are gone now
    for (const pid of Array.from(this.paused)) {
      if (!allLivePids.has(pid) && !heldAfterList(pid)) this.forgetHold(pid);
    }

    // What the agents of this repository run beyond the list: pause holds that too. Never strayps,
    // its wrappers or what it runs: holding those would stop the brake itself.
    this.pauseExtras = new Map();
    for (const raw of rawList) {
      if (this.tracked.has(raw.pid) || raw.pid === this.selfPid || selfAncestors.has(raw.pid)) continue;
      let cur = parentByPid.get(raw.pid);
      for (let depth = 0; cur && cur > 1 && depth < 32; depth++) {
        if (cur === this.selfPid) break;
        const ancestor = this.tracked.get(cur);
        if (ancestor?.category === 'agent') {
          if (ancestor.pauseTarget && !hostOnTheWay(raw.pid, cur)) {
            const elapsedSec = raw.etime !== undefined ? parseElapsedTime(raw.etime).elapsedSec : undefined;
            this.pauseExtras.set(raw.pid, {
              raw,
              elapsedSec,
              startedAt: elapsedSec === undefined ? undefined : listedAt - elapsedSec * 1000,
            });
          }
          break;
        }
        cur = parentByPid.get(cur);
      }
    }
    // With the list it belongs to: set while a scan waits, it paired a new tree with the old list
    this.lastParentByPid = parentByPid;
    this.lastTree = { at: listedAt, raws: rawList };

    const processes = this.getProcesses();
    this.emit('scan-complete', processes);
    return processes;
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
    return this.lastParentByPid.get(pid);
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
      this.terminating.set(pid, { timer, process: proc, sentAt: Date.now() });
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
    if (age !== undefined && age + 1 < (Date.now() - pending.sentAt) / 1000) return;
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
  private stillHeld(raw: RawProcessInfo, now: number, heldAfterList = false): boolean {
    if (!this.paused.has(raw.pid)) return false;
    // held after this list was read: `raw` may be the process that had the PID before
    if (heldAfterList) return true;
    const since = this.heldSince.get(raw.pid);
    if (since && raw.etime !== undefined) {
      const expected = since.elapsedSec + (now - since.at) / 1000;
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
      // the age and the time of the scan that saw it, so the next scans compare like with like
      const at =
        target.startedAt !== undefined && target.elapsedSec !== undefined
          ? target.startedAt + target.elapsedSec * 1000
          : this.lastScanAt;
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

  /** The scan clock now: what a time read now is in the clock the scans run on (tests inject one). */
  private scanClockNow(): number {
    return this.lastScanAt + (Date.now() - this.lastScanWallAt);
  }

  /**
   * True when `ps` reads the PID as younger than the process seen `elapsedSec` old at `at` (scan
   * clock) must be by now: the PID names another process. The same test as `stillHeld`, so that
   * nothing is held that the next scan would take for another process, forget, and leave stopped.
   */
  private youngerThanExpected(age: number | undefined, elapsedSec: number | undefined, at: number): boolean {
    if (age === undefined || elapsedSec === undefined) return false;
    return age + 2 < elapsedSec + Math.max(0, this.scanClockNow() - at) / 1000;
  }

  /** SIGSTOP for one process, remembered with its age at `at` (scan clock) to tell a reused PID later. */
  private hold(pid: number, elapsedSec: number | undefined, at: number): boolean {
    if (pid === this.selfPid || !this.processKiller(pid, 'SIGSTOP')) return false;
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
    const startedAt = Date.now();
    for (let look = 0; ; look++) {
      let fresh: RawProcessInfo[] | undefined;
      try {
        fresh = this.processTree();
      } catch {
        fresh = undefined;
      }
      const tree = fresh ?? this.lastTree.raws;
      // the ages in `tree` are those of this moment, or of the last scan (scan clock)
      const at = fresh ? this.scanClockNow() : this.lastTree.at;
      if (fresh) alive = new Set(fresh.map((raw) => raw.pid));
      const { found, asked } = this.startedBy(agents, tree);
      for (const raw of asked) missed.add(raw.pid);
      if (look >= PAUSE_LOOKS || Date.now() - startedAt > PAUSE_LOOK_BUDGET_MS) {
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
  private startedBy(agents: Set<number>, tree: RawProcessInfo[]): { found: RawProcessInfo[]; asked: RawProcessInfo[] } {
    const byPid = new Map(tree.map((raw) => [raw.pid, raw]));
    const childrenOf = new Map<number, RawProcessInfo[]>();
    for (const raw of tree) {
      if (!raw.ppid || raw.ppid === raw.pid) continue;
      const list = childrenOf.get(raw.ppid);
      if (list) list.push(raw);
      else childrenOf.set(raw.ppid, [raw]);
    }
    const parentOf = (pid: number): number | undefined => byPid.get(pid)?.ppid ?? this.lastParentByPid.get(pid);
    const selfChain = new Set<number>([this.selfPid]);
    for (let cur = parentOf(this.selfPid), depth = 0; cur && cur > 1 && depth < 32; depth++) {
      selfChain.add(cur);
      cur = parentOf(cur);
    }

    // Everything below the agents, breadth first: parents before what they run
    const below: RawProcessInfo[] = [];
    const visited = new Set<number>(agents);
    let level = Array.from(agents);
    for (let depth = 0; level.length > 0 && depth < 32; depth++) {
      const next: number[] = [];
      for (const pid of level) {
        for (const child of childrenOf.get(pid) ?? []) {
          if (visited.has(child.pid)) continue;
          visited.add(child.pid);
          below.push(child);
          next.push(child.pid);
        }
      }
      level = next;
    }

    const categories = new Map<number, ProcessCategory | undefined>();
    const categoryOf = (pid: number): ProcessCategory | undefined => {
      if (!categories.has(pid)) {
        const raw = byPid.get(pid);
        categories.set(pid, raw ? this.classifyProcess(raw)?.category : undefined);
      }
      return categories.get(pid);
    };
    // The client of an MCP server is an agent, whatever it is called (agent recognition, rule 3).
    // A client below the agents has its servers below them as well.
    const clients = new Set<number>();
    for (const raw of below) {
      if (categoryOf(raw.pid) !== 'mcp') continue;
      const client = this.findMcpClient(raw, byPid, categoryOf);
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

    if (MCP_KEYWORDS.some((kw) => haystack.includes(kw))) {
      return { category: 'mcp' };
    }
    // Everything else is listed only when an agent started it (the process tree, in performScan)
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
      // an app that pause never holds is never an agent either (safety review, 22.11.2026)
      if (HOST_PATTERNS.some(([pattern]) => pattern.test(programIdentity(ancestor))) || isAppOrTerminal(ancestor)) {
        return undefined;
      }
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
