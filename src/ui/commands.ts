import { type GuardMode, parseMode } from '../core/guard-config.js';
import type { WatchdogSession } from '../core/session.js';
import { isReclaimable, processTotals, sanitize } from './format.js';

export type LeashCommand =
  | { kind: 'empty' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'status' }
  | { kind: 'mode'; mode: GuardMode }
  | { kind: 'revert'; target: string }
  | { kind: 'kill'; pid: number }
  | { kind: 'clean' }
  | { kind: 'panic' }
  | { kind: 'invalid'; message: string };

export interface CommandResult {
  message: string;
  level: 'info' | 'warn' | 'error';
  /** The watchdog should shut down. */
  exit?: boolean;
  /** The front end should show its help. */
  showHelp?: boolean;
  /** The front end should print or show the current status. */
  showStatus?: boolean;
  /** The command changes or destroys something and only runs after an explicit yes. */
  confirm?: { prompt: string; run: () => CommandResult };
}

export const COMMAND_NAMES = ['help', 'status', 'mode', 'revert', 'kill', 'clean', 'panic', 'exit'];

export const HELP_LINES: Array<[string, string]> = [
  ['exit, quit, q', 'stop the watchdog (Ctrl+C works too)'],
  ['mode <strict|balanced|yolo>', 'switch the guard mode'],
  ['revert <file>', 'roll one modified file back to the session checkpoint'],
  ['kill <pid>', 'terminate one monitored process (SIGTERM, then SIGKILL)'],
  ['clean', 'terminate everything classified as stale or frozen'],
  ['panic', 'kill the processes of this repo and roll back all files'],
  ['status', 'list all monitored processes'],
  ['help, ?', 'show this list'],
];

const EXIT_WORDS = new Set(['exit', 'quit', 'q', ':q', 'stop', 'bye']);
const MODE_WORDS = new Set(['strict', 'balanced', 'yolo', 'refactoring']);

/** Turns one line of user input into a command. Never throws. */
export function parseCommand(line: string): LeashCommand {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };

  const spaceAt = trimmed.search(/\s/);
  const word = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
  const rest = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim();

  if (EXIT_WORDS.has(word)) return { kind: 'exit' };
  if (word === 'help' || word === 'h' || word === '?') return { kind: 'help' };
  if (word === 'status' || word === 's' || word === 'ps') return { kind: 'status' };
  if (word === 'clean' || word === 'cleanup' || word === 'c') return { kind: 'clean' };
  if (word === 'panic' || word === 'panic!') return { kind: 'panic' };

  if (MODE_WORDS.has(word) && !rest) {
    return { kind: 'mode', mode: parseMode(word)! };
  }

  if (word === 'mode' || word === 'm') {
    const mode = parseMode(rest);
    if (!mode) {
      return { kind: 'invalid', message: 'Usage: mode <strict|balanced|yolo>' };
    }
    return { kind: 'mode', mode };
  }

  if (word === 'revert' || word === 'rollback' || word === 'undo' || word === 'r') {
    const target = rest.replace(/^(['"])(.*)\1$/, '$2');
    if (!target) {
      return { kind: 'invalid', message: 'Usage: revert <file> (Tab completes modified files)' };
    }
    return { kind: 'revert', target };
  }

  if (word === 'kill' || word === 'k') {
    if (!/^\d+$/.test(rest)) {
      return { kind: 'invalid', message: 'Usage: kill <pid> (a PID from the process list)' };
    }
    return { kind: 'kill', pid: Number(rest) };
  }

  return { kind: 'invalid', message: `Unknown command "${sanitize(word)}". Type help for the list.` };
}

/**
 * Finds the modified file the user means: the exact path, or the only modified file
 * whose path ends with / contains what was typed.
 */
export function resolveModifiedFile(
  target: string,
  modifiedFiles: string[],
): { file: string } | { error: string } {
  const wanted = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (modifiedFiles.includes(wanted)) return { file: wanted };

  let matches = modifiedFiles.filter((f) => f.endsWith(`/${wanted}`));
  if (matches.length === 0) {
    matches = modifiedFiles.filter((f) => f.includes(wanted));
  }
  if (matches.length === 1) return { file: matches[0] };
  if (matches.length > 1) {
    const shown = matches.slice(0, 4).map(sanitize).join(', ');
    return { error: `"${sanitize(target)}" matches ${matches.length} modified files: ${shown}${matches.length > 4 ? ', …' : ''}` };
  }
  return { error: `"${sanitize(target)}" is not a file modified in this session` };
}

/**
 * Executes a parsed command against the session. Destructive commands do nothing yet:
 * they return a `confirm` step that the front end must put to the user first.
 */
export function runCommand(session: WatchdogSession, command: LeashCommand): CommandResult {
  switch (command.kind) {
    case 'empty':
      return { message: '', level: 'info' };

    case 'invalid':
      return { message: command.message, level: 'error' };

    case 'help':
      return { message: '', level: 'info', showHelp: true };

    case 'status':
      return { message: '', level: 'info', showStatus: true };

    case 'exit':
      return { message: 'Shutting down…', level: 'info', exit: true };

    case 'mode': {
      const result = session.setMode(command.mode);
      return result.ok
        ? { message: `Guard mode is now ${result.config.mode.toUpperCase()}`, level: 'info' }
        : { message: result.error, level: 'error' };
    }

    case 'revert': {
      const resolved = resolveModifiedFile(command.target, session.getSnapshot().modifiedFiles);
      if ('error' in resolved) {
        return { message: resolved.error, level: 'error' };
      }
      const file = resolved.file;
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `Roll ${sanitize(file)} back to the session checkpoint?`,
          run: () =>
            session.rollbackFile(file)
              ? { message: `Rolled back ${sanitize(file)}`, level: 'info' }
              : { message: `Could not roll back ${sanitize(file)} (see activity log)`, level: 'error' },
        },
      };
    }

    case 'kill': {
      const proc = session.getSnapshot().processes.find((p) => p.pid === command.pid);
      if (!proc) {
        return {
          message: `PID ${command.pid} is not in the monitored process list`,
          level: 'error',
        };
      }
      const where = proc.cwd ? `, ${sanitize(proc.cwd)}` : '';
      const attached =
        proc.host && proc.host !== 'detached' ? ` It is attached to ${sanitize(proc.host)}.` : '';
      const caution = isReclaimable(proc) ? '' : ' It is NOT classified as stale.';
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `Terminate PID ${proc.pid} (${sanitize(proc.cmd)}${where}, ${proc.memoryMb.toFixed(0)} MB)?${caution}${attached}`,
          run: () => {
            const result = session.killProcess(proc.pid);
            return result.ok
              ? { message: `Sent SIGTERM to PID ${proc.pid}`, level: 'info' }
              : { message: result.error, level: 'error' };
          },
        },
      };
    }

    case 'clean': {
      const stale = session.getStaleProcesses();
      if (stale.length === 0) {
        return { message: 'Nothing is classified as stale or frozen', level: 'info' };
      }
      const totals = processTotals(stale);
      const hosts = Array.from(
        new Set(stale.map((p) => p.host).filter((h): h is string => Boolean(h) && h !== 'detached')),
      );
      const attached =
        hosts.length > 0
          ? ` Some belong to an open ${hosts.map(sanitize).join(' / ')}, which will report an ended session.`
          : '';
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `Terminate ${stale.length} stale/frozen process${stale.length === 1 ? '' : 'es'} (${totals.totalMb.toFixed(0)} MB)?${attached}`,
          run: () => {
            const killed = session.killStale();
            return {
              message: `Sent SIGTERM to ${killed.length} process${killed.length === 1 ? '' : 'es'}`,
              level: 'info',
            };
          },
        },
      };
    }

    case 'panic': {
      const snapshot = session.getSnapshot();
      const repoProcs = snapshot.processes.filter((p) => p.inWatchedRepo).length;
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `PANIC: kill ${repoProcs} process${repoProcs === 1 ? '' : 'es'} of this repo and roll back ${snapshot.modifiedFiles.length} modified file${snapshot.modifiedFiles.length === 1 ? '' : 's'}?`,
          run: () => {
            const result = session.panic();
            const skipped = result.skippedFiles.length
              ? `, ${result.skippedFiles.length} skipped`
              : '';
            return {
              message: `PANIC done: ${result.restoredCount} file${result.restoredCount === 1 ? '' : 's'} restored${skipped}, ${result.killedPids.length} process${result.killedPids.length === 1 ? '' : 'es'} killed`,
              level: 'warn',
            };
          },
        },
      };
    }
  }
}

export interface Completion {
  /** The input after completion (unchanged if nothing could be completed). */
  input: string;
  /** All candidates when the completion is ambiguous. */
  candidates: string[];
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** Tab completion: command names, guard modes, modified files and monitored PIDs. */
export function completeInput(session: WatchdogSession, input: string): Completion {
  const spaceAt = input.search(/\s/);
  let head = '';
  let partial = input;
  let pool: string[] = COMMAND_NAMES;

  if (spaceAt !== -1) {
    const word = input.slice(0, spaceAt).toLowerCase();
    head = input.slice(0, spaceAt + 1);
    partial = input.slice(spaceAt + 1).replace(/^\s+/, '');
    const snapshot = session.getSnapshot();
    if (word === 'mode' || word === 'm') {
      pool = ['strict', 'balanced', 'yolo'];
    } else if (word === 'revert' || word === 'rollback' || word === 'undo' || word === 'r') {
      pool = snapshot.modifiedFiles;
    } else if (word === 'kill' || word === 'k') {
      pool = snapshot.processes.map((p) => String(p.pid));
    } else {
      return { input, candidates: [] };
    }
  }

  let matches = pool.filter((candidate) => candidate.startsWith(partial));
  if (matches.length === 0 && partial.length > 0 && head) {
    // Paths are easier to hit by any fragment than by their prefix
    matches = pool.filter((candidate) => candidate.includes(partial));
    if (matches.length === 1) return { input: head + matches[0], candidates: [] };
    return { input, candidates: matches.slice(0, 8) };
  }
  if (matches.length === 0) return { input, candidates: [] };
  if (matches.length === 1) {
    return { input: head + matches[0] + (head ? '' : ' '), candidates: [] };
  }
  const prefix = commonPrefix(matches);
  return {
    input: head + (prefix.length > partial.length ? prefix : partial),
    candidates: matches.slice(0, 8),
  };
}
