import os from 'node:os';
import type { MonitoredProcess } from '../core/process-monitor.js';
import type { StatusSnapshot } from '../core/session.js';
import type { WatchActivityEvent } from '../core/watcher.js';

/**
 * File names, command lines and working directories come from the processes being watched.
 * Before any of it reaches a terminal, control characters and escape sequences are neutralized
 * (a file name must not be able to clear the screen, move the cursor or retitle the window),
 * as are bidirectional overrides that would let text display differently from what it is.
 */
export function sanitize(text: unknown): string {
  return String(text ?? '').replace(
    /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g,
    '?',
  );
}

/** Cuts `text` to `width` visible characters, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}

/** Like `truncate`, but keeps the end: the tail of a path says more than its head. */
export function truncateStart(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return '…';
  return `…${chars.slice(chars.length - (width - 1)).join('')}`;
}

export function padEnd(text: string, width: number): string {
  const len = Array.from(text).length;
  return len >= width ? text : text + ' '.repeat(width - len);
}

export function padStart(text: string, width: number): string {
  const len = Array.from(text).length;
  return len >= width ? text : ' '.repeat(width - len) + text;
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** `/Users/me/Projekte/app` -> `~/Projekte/app` */
export function tildify(absPath: string): string {
  const home = os.homedir();
  if (home && (absPath === home || absPath.startsWith(home + '/'))) {
    return `~${absPath.slice(home.length)}`;
  }
  return absPath;
}

export type Style = (text: string) => string;

export interface Palette {
  accent: Style;
  ok: Style;
  warn: Style;
  danger: Style;
  dim: Style;
  strong: Style;
  plain: Style;
}

/**
 * ANSI styling with the brand green when the terminal supports 24-bit color,
 * standard green otherwise, and no escape codes at all when colors are off.
 */
export function createPalette(enabled: boolean, truecolor: boolean = false): Palette {
  const plain: Style = (text) => text;
  if (!enabled) {
    return { accent: plain, ok: plain, warn: plain, danger: plain, dim: plain, strong: plain, plain };
  }
  const wrap =
    (open: string): Style =>
    (text) =>
      text.length === 0 ? text : `\u001b[${open}m${text}\u001b[0m`;
  const green = truecolor ? '38;2;91;228;155' : '32';
  return {
    accent: wrap(`1;${green}`),
    ok: wrap(green),
    warn: wrap('33'),
    danger: wrap('1;31'),
    dim: wrap('2'),
    strong: wrap('1'),
    plain,
  };
}

/** Honors NO_COLOR (https://no-color.org) and FORCE_COLOR, otherwise colors only on a TTY. */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function supportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
}

export function severityStyle(palette: Palette, severity: WatchActivityEvent['severity']): Style {
  if (severity === 'critical') return palette.danger;
  if (severity === 'warn') return palette.warn;
  return palette.ok;
}

export function statusStyle(palette: Palette, proc: MonitoredProcess): Style {
  if (proc.status === 'FROZEN') return palette.danger;
  if (proc.status === 'STALE') return palette.warn;
  if (proc.status === 'ACTIVE') return palette.ok;
  return palette.dim;
}

export function isReclaimable(proc: MonitoredProcess): boolean {
  return proc.status === 'FROZEN' || proc.status === 'STALE' || proc.safety === 'safe-to-kill';
}

/** Short kill-safety label. Unlike the raw `safety` value it says where the process lives. */
export function safetyLabel(proc: MonitoredProcess): string {
  if (isReclaimable(proc)) return 'SAFE TO KILL';
  if (proc.safety === 'standby-mcp') return 'STANDBY';
  return proc.inWatchedRepo ? 'IN REPO' : 'ELSEWHERE';
}

export interface ProcessTotals {
  count: number;
  totalMb: number;
  reclaimableCount: number;
  reclaimableMb: number;
}

export function processTotals(processes: MonitoredProcess[]): ProcessTotals {
  const reclaimable = processes.filter(isReclaimable);
  return {
    count: processes.length,
    totalMb: processes.reduce((sum, p) => sum + p.memoryMb, 0),
    reclaimableCount: reclaimable.length,
    reclaimableMb: reclaimable.reduce((sum, p) => sum + p.memoryMb, 0),
  };
}

/** One log line for an activity event, used by the plain (non-interactive) output. */
export function formatEventLine(event: WatchActivityEvent, palette: Palette): string {
  const level =
    event.severity === 'critical' ? 'CRIT' : event.severity === 'warn' ? 'WARN' : 'INFO';
  const style = severityStyle(palette, event.severity);
  return `${palette.dim(formatClock(event.timestamp))}  ${style(padEnd(level, 4))}  ${padEnd(event.type, 18)} ${sanitize(event.message)}`;
}

/** The process table as plain lines, used by `agent-leash status` and the `status` command. */
export function formatProcessTable(
  processes: MonitoredProcess[],
  palette: Palette,
  width: number = 120,
): string[] {
  if (processes.length === 0) {
    return ['  No agent or MCP processes found.'];
  }
  const lines: string[] = [];
  const header = `  ${padEnd('PID', 7)} ${padEnd('STATUS', 8)} ${padEnd('SAFETY', 13)} ${padStart('RAM', 9)} ${padStart('AGE', 8)}  COMMAND · CWD`;
  lines.push(palette.dim(header));
  lines.push(palette.dim(`  ${'─'.repeat(Math.max(20, Math.min(width, 120) - 2))}`));
  for (const proc of processes) {
    const style = statusStyle(palette, proc);
    const where = proc.cwd ? ` · ${sanitize(proc.cwd)}` : '';
    const host = proc.host && proc.host !== 'detached' ? ` [${sanitize(proc.host)}]` : '';
    const fixed = `  ${padEnd(String(proc.pid), 7)} `;
    const tail = `${padStart(`${proc.memoryMb.toFixed(1)} MB`, 9)} ${padStart(sanitize(proc.uptime), 8)}  `;
    const used = fixed.length + 8 + 1 + 13 + 1 + tail.length;
    const rest = truncate(`${sanitize(proc.cmd)}${where}${host}`, Math.max(10, width - used));
    lines.push(
      `${fixed}${style(padEnd(proc.status, 8))} ${(isReclaimable(proc) ? palette.warn : palette.dim)(padEnd(safetyLabel(proc), 13))} ${tail}${rest}`,
    );
  }
  return lines;
}

/** A compact multi-line status report (metrics + processes) for non-interactive output. */
export function formatStatusReport(
  snapshot: StatusSnapshot,
  palette: Palette,
  width: number = 120,
): string[] {
  const { config } = snapshot;
  const totals = processTotals(snapshot.processes);
  const limits =
    config.mode === 'yolo'
      ? 'unlimited (yolo)'
      : `warn ${config.limits.maxFilesWarn} · stop ${config.limits.maxFilesHardStop}`;
  const breaker =
    snapshot.trippedFiles.length > 0
      ? palette.danger(`TRIPPED: ${snapshot.trippedFiles.map(sanitize).join(', ')}`)
      : palette.ok('armed');
  const lines = [
    `  Repo:        ${sanitize(tildify(snapshot.rootDir))}`,
    `  Mode:        ${config.mode.toUpperCase()}`,
    `  Files:       ${snapshot.modifiedFiles.length} modified (${limits})${snapshot.limitState === 'hard-stop' ? palette.danger('  HARD STOP limit reached') : ''}`,
    `  Breaker:     ${breaker} (max ${config.limits.maxEditsPerFilePerMinute} edits/file/min)`,
    `  Processes:   ${totals.count} monitored (${totals.totalMb.toFixed(1)} MB) · ${totals.reclaimableCount} stale/frozen (${totals.reclaimableMb.toFixed(1)} MB reclaimable)`,
    '',
    ...formatProcessTable(snapshot.processes, palette, width),
  ];
  return lines;
}
