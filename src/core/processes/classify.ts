// The status and the reason a listed process is shown with, from what one scan observed about it.
// STALE and FROZEN describe what is observed. They are never presented as "safe to kill": age and
// silence alone have been wrong about sessions that were still in use. The rules and the incidents
// behind them: skill process-classification, section 2.

import { NON_APP_HOSTS } from './recognition.js';
import type { AgentDetection, ProcessCategory, ProcessHealthStatus } from './types.js';

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

/** What a scan observed about one listed process. */
export interface ProcessFacts {
  pid: number;
  ppid?: number;
  pgid?: number;
  cmd?: string;
  category: ProcessCategory;
  detectedBy?: AgentDetection;
  /** Its working directory, if known (the real path). */
  cwd?: string;
  /** The same as shown: the home directory as ~. */
  displayCwd?: string;
  /** It works inside the watched repository, or descends from a listed process that does. */
  belongsToWatchedRepo: boolean;
  host?: string;
  /**
   * Its parent is in the process table, and so is the parent's parent unless that is PID 1 or
   * unknown (the table as `ps` read it, not only what strayps lists).
   */
  hasLiveParentChain: boolean;
  elapsedSec: number;
  formattedUptime: string;
  /**
   * It used CPU time since the last scan. `ps %cpu` stands in where that cannot be compared: the
   * first scan, a PID the system gave to a new process, a lister without CPU time.
   */
  hasCpuActivity: boolean;
  /** CPU time used since it started; undefined when the lister cannot read it. */
  cpuTimeSec?: number;
  /** CPU time used over the quiet window; undefined until it has been watched that long. */
  usedInWindowSec?: number;
  /** Milliseconds since it last started a new process, if it ever did while watched. */
  sinceNewChildMs?: number;
  silenceSec: number;
  /** Held by strayps right now. */
  paused: boolean;
  /** Status of the nearest monitored agent above this process in this scan, if any. */
  parentAgentStatus?: ProcessHealthStatus;
}

/** The thresholds the rules use: always the configured values, never the defaults as literals. */
export interface ClassifyLimits {
  staleSessionSec: number;
  staleQuietSec: number;
  mcpSilenceTimeoutSec: number;
  agentActive: boolean;
}

export function formatCpu(sec: number): string {
  return `${sec.toFixed(2)} s`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Decides in the order of the table in the skill; the first rule that matches wins. */
export function classifyStatus(
  facts: ProcessFacts,
  limits: ClassifyLimits,
): { status: ProcessHealthStatus; reason: string } {
  const { category, detectedBy, cpuTimeSec, usedInWindowSec, sinceNewChildMs, hasCpuActivity } = facts;
  const { elapsedSec, formattedUptime, displayCwd, belongsToWatchedRepo, host, silenceSec } = facts;
  const startedProcessRecently = sinceNewChildMs !== undefined && sinceNewChildMs < limits.staleQuietSec * 1000;
  const quietLongEnough =
    usedInWindowSec !== undefined && usedInWindowSec < STALE_CPU_BUDGET_SEC && !startedProcessRecently;
  const idleNote = `idle: no new process and ${formatCpu(usedInWindowSec ?? 0)} CPU time in the last ${formatDuration(limits.staleQuietSec)}`;

  const isOtherRepo = typeof facts.cwd === 'string' && facts.cwd.length > 0 && !belongsToWatchedRepo;

  const hostNote = host && host !== 'detached' ? `, attached to ${host}` : '';

  const isStaleByAge = elapsedSec >= limits.staleSessionSec;
  // PPID 1 alone does not mean the parent is gone: on macOS launchd is the parent of every app
  // started from the Dock or Finder, and makes each one the leader of its own process group.
  // A process whose parent died keeps the group it was started in. Without a known group
  // there is no evidence, so nothing is called orphaned.
  const isOrphaned =
    facts.ppid === 1 && facts.pgid !== undefined && facts.pgid !== facts.pid && category !== 'agent';
  const rawCmdLower = (facts.cmd ?? '').toLowerCase();
  const isDevServer =
    rawCmdLower.includes('next dev') ||
    rawCmdLower.includes('turbopack') ||
    rawCmdLower.includes('vite') ||
    rawCmdLower.includes('cli.js test-server');

  // An idle MCP server of an open editor or desktop app waits for its next tool call; it was
  // called STALE after 10 idle minutes although the app was in use (20.11.2026). A terminal,
  // tmux or SSH session says nothing about whether anyone still uses what runs in it.
  const heldByRunningApp =
    facts.hasLiveParentChain && facts.ppid !== 1 && host !== undefined && !NON_APP_HOSTS.has(host);

  // An MCP server or child process of an agent that is still in use waits for that agent; an MCP
  // server started directly by an open editor or desktop app (no agent in between) waits for the
  // app. Neither is stale on its own just because it sits idle while its owner is running
  // (22.11.2026: active Claude Desktop session's MCP server with a repo cwd was marked STALE).
  // A sub-agent in another repository is a session of its own and is still judged on its own.
  const heldByActiveAgent =
    category !== 'agent' &&
    facts.parentAgentStatus !== undefined &&
    facts.parentAgentStatus !== 'STALE' &&
    facts.parentAgentStatus !== 'FROZEN';
  const heldDirectlyByRunningApp =
    category === 'mcp' && facts.parentAgentStatus === undefined && heldByRunningApp;
  const keptAliveByOwner = heldByActiveAgent || heldDirectlyByRunningApp;

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
  } else if (isOtherRepo && isStaleByAge && !keptAliveByOwner && quietLongEnough) {
    // Age alone called sessions stale that were still in use at an open editor:
    // a session in another repository is stale only when it is old AND has used no CPU time
    // for a measured window.
    status = 'STALE';
    reason = `Session in ${displayCwd}, running for ${formattedUptime}, ${idleNote}${hostNote}`;
  } else if (isOtherRepo && isStaleByAge && !keptAliveByOwner) {
    reason =
      cpuTimeSec === undefined
        ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; its CPU time cannot be read, so it is never called stale`
        : usedInWindowSec === undefined
          ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; watching for ${formatDuration(limits.staleQuietSec)} whether it is still in use`
          : startedProcessRecently
            ? `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; in use: started a process ${formatDuration(Math.floor(sinceNewChildMs! / 1000))} ago`
            : `Session in ${displayCwd}, running for ${formattedUptime}${hostNote}; in use: ${formatCpu(usedInWindowSec)} CPU time in the last ${formatDuration(limits.staleQuietSec)}`;
  } else if (
    !belongsToWatchedRepo &&
    !facts.cwd &&
    isStaleByAge &&
    quietLongEnough &&
    category === 'mcp' &&
    !keptAliveByOwner
  ) {
    // Detached MCP process without a repository cwd, older than staleSessionHours
    status = 'STALE';
    reason = `MCP process without a working directory, running for ${formattedUptime}, ${idleNote}${hostNote}`;
  } else if (isOrphaned && !hasCpuActivity && elapsedSec >= limits.mcpSilenceTimeoutSec) {
    status = 'FROZEN';
    reason = `Orphaned: its parent is gone (PPID 1), running for ${formattedUptime}`;
  } else if (category === 'mcp' && !hasCpuActivity && facts.hasLiveParentChain) {
    // MCP child server whose parent is alive: 0% CPU is normal standby behavior
    // while it waits for stdin tool requests, regardless of session age.
    status = 'STANDBY';
    reason = `Standby MCP child (PPID ${facts.ppid} alive, age ${formattedUptime}) — waiting for tool call`;
  } else if (belongsToWatchedRepo && category === 'agent') {
    // An agent session in the currently watched repository is NEVER marked stale or frozen
    // just because the developer has been working in the repo for hours or is thinking.
    status = hasCpuActivity ? 'ACTIVE' : 'IDLE';
    reason = `Agent session in current repository (open for ${formattedUptime})`;
  } else if (limits.agentActive && silenceSec >= limits.mcpSilenceTimeoutSec && !isDevServer) {
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

  // A held process uses no CPU by design: that is neither stale nor frozen
  if (facts.paused) {
    if (status === 'FROZEN' || status === 'STALE') status = 'IDLE';
    reason = 'Paused by strayps; resume continues it';
  }
  return { status, reason };
}
