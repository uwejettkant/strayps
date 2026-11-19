import type { MonitoredProcess } from '../core/process-monitor.js';
import type { WatchdogSession } from '../core/session.js';
import { PANIC_WINDOW_MS } from '../core/watcher.js';
import { sanitize } from './format.js';

export type LeashCommand =
  | { kind: 'empty' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'status' }
  | { kind: 'revert'; target: string }
  | { kind: 'kill'; pid: number }
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

export const COMMAND_NAMES = ['help', 'status', 'revert', 'kill', 'panic', 'exit'];

export const HELP_LINES: Array<[string, string]> = [
  ['exit, quit, q', 'stop the watchdog (Ctrl+C works too)'],
  ['revert <file>', 'roll one file back to the version before its latest changes'],
  ['kill <pid>', 'terminate one monitored process (SIGTERM, then SIGKILL)'],
  ['panic', 'stop the agents of this repo, roll back what changed in the last 10 min'],
  ['status', 'list all monitored processes'],
  ['help, ?', 'show this list'],
];

/** A short name for a process: the npm binary it runs, or the file name of its program. */
function shortName(proc: MonitoredProcess): string {
  const bin = proc.cmd.match(/\.bin\/(\S+)/);
  if (bin) return bin[1];
  const first = proc.cmd.trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() || 'process';
}

/** "claude-code 48110, mcp-server-git 48244, … (+2 more)" for a confirmation prompt. */
function describeProcesses(processes: MonitoredProcess[], shown: number = 3): string {
  const names = processes.slice(0, shown).map((p) => `${sanitize(shortName(p))} ${p.pid}`);
  const more = processes.length > shown ? `, … (+${processes.length - shown} more)` : '';
  return `${names.join(', ')}${more}`;
}

const EXIT_WORDS = new Set(['exit', 'quit', 'q', ':q', 'stop', 'bye']);

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
  if (word === 'clean' || word === 'cleanup') {
    // Bulk cleanup relied on a stale/frozen verdict that was wrong about sessions still in use
    return {
      kind: 'invalid',
      message: 'There is no bulk cleanup: look at the list (status) and terminate one process with kill <pid>.',
    };
  }
  if (word === 'panic' || word === 'panic!') return { kind: 'panic' };

  if (word === 'mode' || word === 'm' || ['strict', 'balanced', 'yolo'].includes(word)) {
    // The modes were removed: agent-leash always watches by the settings in .agentguard.json
    return {
      kind: 'invalid',
      message: 'There are no modes any more: agent-leash watches by your settings (agent-leash config).',
    };
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
          prompt: `Roll ${sanitize(file)} back to the version before its latest changes?`,
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
      const agentNote = proc.category === 'agent' ? ' Its agent session ends.' : '';
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `Terminate PID ${proc.pid} (${sanitize(proc.cmd)}${where}, ${proc.memoryMb.toFixed(0)} MB)?${agentNote}${attached}`,
          run: () => {
            const result = session.killProcess(proc.pid);
            return result.ok
              ? { message: `Sent SIGTERM to PID ${proc.pid}`, level: 'info' }
              : { message: result.error, level: 'error' };
          },
        },
      };
    }

    case 'panic': {
      const snapshot = session.getSnapshot();
      const targets = session.getPanicTargets();
      const files = snapshot.panicFiles.length;
      const older = snapshot.modifiedFiles.filter(
        (f) => !snapshot.panicFiles.includes(f) && !session.watcher.isEnvFile(f),
      ).length;
      const minutes = Math.round(PANIC_WINDOW_MS / 60_000);
      // Both counts first: a narrow terminal cuts the end of the line, and the list can take that
      const fileText = `roll back ${files} file${files === 1 ? '' : 's'} changed in the last ${minutes} min${older > 0 ? ` (${older} older kept)` : ''}`;
      const stopText =
        targets.length > 0
          ? ` and stop ${targets.length} process${targets.length === 1 ? '' : 'es'} of this repo's agents (${describeProcesses(targets)})`
          : ' (no agent of this repo is running)';
      return {
        message: '',
        level: 'warn',
        confirm: {
          prompt: `PANIC: ${fileText}${stopText}?`,
          run: () => {
            const result = session.panic();
            const skipped = result.skippedFiles.length
              ? `, ${result.skippedFiles.length} skipped`
              : '';
            const kept = result.keptFiles.length ? `, ${result.keptFiles.length} older kept` : '';
            return {
              message: `PANIC done: ${result.restoredCount} file${result.restoredCount === 1 ? '' : 's'} rolled back${skipped}${kept}, ${result.killedPids.length} process${result.killedPids.length === 1 ? '' : 'es'} killed`,
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

/** Tab completion: command names, modified files and monitored PIDs. */
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
    if (word === 'revert' || word === 'rollback' || word === 'undo' || word === 'r') {
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
