// The real process table and the real signals: `ps` is read here, and this is the only module that
// signals a process. The monitor gets these functions as defaults; tests and the demo inject fakes
// instead (AGENTS.md, section 2, rule 1).

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawProcessInfo } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Programs by full path on macOS, where their place is fixed: found through PATH, a `ps` or
 * `footprint` in the repository's node_modules/.bin (first in PATH under npx and npm scripts)
 * would have run instead (review, 20.11.2026). Linux keeps the PATH lookup, its paths vary.
 */
const IS_MAC = process.platform === 'darwin';
export const PS_BIN = IS_MAC ? '/bin/ps' : 'ps';
export const LSOF_BIN = IS_MAC ? '/usr/sbin/lsof' : 'lsof';
export const FOOTPRINT_BIN = '/usr/bin/footprint';

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
