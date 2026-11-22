// The records the monitor, the session and the front ends share. No logic here.

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
  /** When it started (ms, monotonic clock): its age at the scan that listed it, taken from that scan's time. */
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
   * When it started (ms, monotonic clock), from its age and the monotonic time of the scan that
   * saw it: tells the process a person confirmed from a newer one under the same PID even if the
   * system wall clock jumps. Undefined when unknown.
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

export interface ProcessKilledEvent {
  pid: number;
  process?: MonitoredProcess;
  signal: NodeJS.Signals;
  /** True when SIGKILL followed an ignored SIGTERM. */
  escalated?: boolean;
}
