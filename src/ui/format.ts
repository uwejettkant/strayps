import os from 'node:os';
import { formatMemory, sumMemory } from '../core/processes/memory.js';
import type { MonitoredProcess } from '../core/processes/types.js';
import type { StatusSnapshot } from '../core/session.js';
import type { ActivityEvent } from '../core/events.js';

/**
 * File names, command lines and working directories come from the processes being watched.
 * Before any of it reaches a terminal, control characters and escape sequences are neutralized
 * (a file name must not be able to clear the screen, move the cursor or retitle the window),
 * as are bidirectional overrides that would let text display differently from what it is.
 * The pattern names them as escapes: written raw, they are invisible in the source, and GitHub warns
 * about hidden bidirectional text on the file.
 */
export function sanitize(text: unknown): string {
  return String(text ?? '').replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
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
  const home = os.homedir().replace(/\/+$/, '');
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

export function severityStyle(palette: Palette, severity: ActivityEvent['severity']): Style {
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

/** Worth a look: old, orphaned or silent. An observation, never a reason to kill on its own. */
export function isStaleOrFrozen(proc: MonitoredProcess): boolean {
  return proc.status === 'FROZEN' || proc.status === 'STALE';
}

/** Where a process belongs: the watched repository, somewhere else, or nowhere (orphaned). */
export function whereLabel(proc: MonitoredProcess): string {
  if (proc.inWatchedRepo) return 'THIS REPO';
  if (proc.host === 'detached') return 'DETACHED';
  return 'ELSEWHERE';
}

export interface ProcessTotals {
  count: number;
  totalMb: number;
  staleCount: number;
  staleMb: number;
  /** "477 MB", with a "~" when one of the values is only RSS */
  total: string;
  stale: string;
}

export function processTotals(processes: MonitoredProcess[], digits = 0): ProcessTotals {
  const stale = processes.filter(isStaleOrFrozen);
  return {
    count: processes.length,
    totalMb: processes.reduce((sum, p) => sum + p.memoryMb, 0),
    staleCount: stale.length,
    staleMb: stale.reduce((sum, p) => sum + p.memoryMb, 0),
    total: sumMemory(processes, digits),
    stale: sumMemory(stale, digits),
  };
}

/** One log line for an activity event, used by the plain (non-interactive) output. */
export function formatEventLine(event: ActivityEvent, palette: Palette): string {
  const level =
    event.severity === 'critical' ? 'CRIT' : event.severity === 'warn' ? 'WARN' : 'INFO';
  const style = severityStyle(palette, event.severity);
  return `${palette.dim(formatClock(event.timestamp))}  ${style(padEnd(level, 4))}  ${padEnd(event.type, 18)} ${sanitize(event.message)}`;
}

/**
 * How wide plain output may be: the terminal's width, else `COLUMNS` (a pipe or file has no width
 * of its own), else 120.
 */
export function outputWidth(stream: { columns?: number }, env: NodeJS.ProcessEnv = process.env): number {
  if (stream.columns) return stream.columns;
  const fromEnv = Number.parseInt(env.COLUMNS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120;
}

/** Below this many characters a command is unreadable: then the app label gives way too. */
const MIN_COMMAND_ROOM = 12;

/**
 * Command, directory and attached app of a process row within `room` visible characters. The app
 * label is short and tells which window a session belongs to, so the command and the directory give
 * way first: appended after them, it was the first thing cut (scenario pass, 20.11.2026: piped
 * `status` lost it on 4 of 6 rows).
 */
export function rowText(proc: MonitoredProcess, room: number): { command: string; rest: string } {
  const command = sanitize(proc.cmd);
  const where = proc.cwd ? ` · ${sanitize(proc.cwd)}` : '';
  const host = proc.host && proc.host !== 'detached' ? ` [${sanitize(proc.host)}]` : '';
  const hostLength = Array.from(host).length;
  const kept = host && room - hostLength >= MIN_COMMAND_ROOM ? host : '';
  const text = Array.from(truncate(`${command}${where}`, Math.max(1, room - (kept ? hostLength : 0))));
  const commandLength = Array.from(command).length;
  if (text.length <= commandLength) return { command: text.join(''), rest: kept };
  return { command, rest: `${text.slice(commandLength).join('')}${kept}` };
}

/** The process table as plain lines, used by `strayps status` and the `status` command. */
export function formatProcessTable(
  processes: MonitoredProcess[],
  palette: Palette,
  width: number = 120,
): string[] {
  if (processes.length === 0) {
    return ['  No agent or MCP processes found.'];
  }
  const lines: string[] = [];
  const header = `  ${padEnd('PID', 7)} ${padEnd('STATUS', 8)} ${padEnd('WHERE', 10)} ${padStart('RAM', 9)} ${padStart('AGE', 8)}  ${padEnd('KIND', 5)}  COMMAND · CWD`;
  lines.push(palette.dim(header));
  lines.push(palette.dim(`  ${'─'.repeat(Math.max(20, Math.min(width, 120) - 2))}`));
  for (const proc of processes) {
    const style = statusStyle(palette, proc);
    const fixed = `  ${padEnd(String(proc.pid), 7)} `;
    const tail = `${padStart(formatMemory(proc.memoryMb, proc.memorySource !== 'footprint'), 9)} ${padStart(sanitize(proc.uptime), 8)}  `;
    const kind = `${padEnd(proc.category, 5)}  `;
    const used = fixed.length + 8 + 1 + 10 + 1 + tail.length + kind.length;
    const { command, rest } = rowText(proc, Math.max(10, width - used));
    lines.push(
      `${fixed}${(proc.paused ? palette.warn : style)(padEnd(proc.paused ? 'PAUSED' : proc.status, 8))} ${palette.dim(padEnd(whereLabel(proc), 10))} ${tail}${palette.dim(kind)}${command}${palette.dim(rest)}`,
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
  const totals = processTotals(snapshot.processes, 1);
  const lines = [
    `  Repo:        ${sanitize(tildify(snapshot.rootDir))}`,
    `  Processes:   ${totals.count} monitored (${totals.total}) · ${totals.staleCount} stale/frozen (${totals.stale})`,
    '',
    ...formatProcessTable(snapshot.processes, palette, width),
  ];
  return lines;
}
