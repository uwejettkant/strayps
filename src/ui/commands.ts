import { formatMemory, sumMemory } from '../core/processes/memory.js';
import type { MonitoredProcess, PauseTarget } from '../core/processes/types.js';
import type { MonitorSession } from '../core/session.js';
import { sanitize } from './format.js';

export type LeashCommand =
  | { kind: 'empty' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'status' }
  | { kind: 'kill'; pid: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'invalid'; message: string };

export interface CommandResult {
  message: string;
  level: 'info' | 'warn' | 'error';
  /** strayps should shut down. */
  exit?: boolean;
  /** The front end should show its help. */
  showHelp?: boolean;
  /** The front end should print or show the current status. */
  showStatus?: boolean;
  /**
   * The command changes or destroys something and only runs after an explicit yes. `details` are
   * lines a front end shows in full before the question, one per process that the answer affects.
   */
  confirm?: {
    prompt: string;
    details?: string[];
    /** What yes does to the listed processes: end them (default) or hold them. */
    effect?: 'end' | 'hold';
    run: () => CommandResult;
  };
}

export const COMMAND_NAMES = ['help', 'status', 'kill', 'pause', 'resume', 'exit'];

export const HELP_LINES: Array<[string, string]> = [
  ['exit, quit, q', 'stop the monitor (Ctrl+C works too)'],
  ['kill <pid>', 'terminate one process; for an agent, its session (asks first)'],
  ['pause', "hold this repo's agents (nothing is lost)"],
  ['resume', 'continue what pause held'],
  ['status', 'list all monitored processes'],
  ['help, ?', 'show this list'],
];

/** A short name for a process: the npm binary it runs, or the file name of its program. */
function shortName(proc: Pick<MonitoredProcess, 'cmd'>): string {
  const bin = proc.cmd.match(/\.bin\/(\S+)/);
  if (bin) return bin[1];
  const first = proc.cmd.trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() || 'process';
}

/** One line per process pause would hold. */
function describePauseTarget(target: PauseTarget): string {
  const where = target.cwd ? `  ${sanitize(target.cwd)}` : '';
  const note = target.listed ? '' : '  not in the list yet';
  return `PID ${target.pid}  ${target.category}  ${sanitize(shortName(target))}${where}${note}`;
}

/** One line per process in a confirmation: what it is, where it works, what it holds. */
function describeForConfirmation(proc: MonitoredProcess): string {
  const where = proc.cwd ? `  ${sanitize(proc.cwd)}` : '';
  return `PID ${proc.pid}  ${proc.category}  ${sanitize(shortName(proc))}${where}  ${formatMemory(proc.memoryMb, proc.memorySource !== 'footprint', 0)}`;
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
  if (word === 'pause') return { kind: 'pause' };
  if (word === 'resume' || word === 'continue') return { kind: 'resume' };
  if (word === 'panic' || word === 'panic!') {
    // panic stopped agents for good and rolled files back; a long run is paid work
    return {
      kind: 'invalid',
      message: 'panic was replaced by pause: it holds the agents of this repo without losing anything; resume continues them.',
    };
  }

  if (word === 'mode' || word === 'm' || ['strict', 'balanced', 'yolo'].includes(word)) {
    // The modes were removed: strayps always watches by the settings in .strayps.json
    return {
      kind: 'invalid',
      message: 'There are no modes any more: strayps watches by your settings (strayps config).',
    };
  }

  if (word === 'revert' || word === 'rollback' || word === 'undo') {
    // The file guard was removed: git and the agents' own checkpoints know better what an agent changed
    return {
      kind: 'invalid',
      message: 'Files are not watched any more: use git, or the checkpoints of your agent (Claude Code: /rewind).',
    };
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
 * Executes a parsed command against the session. Destructive commands do nothing yet:
 * they return a `confirm` step that the front end must put to the user first.
 */
export function runCommand(session: MonitorSession, command: LeashCommand): CommandResult {
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

    case 'kill': {
      const plan = session.getKillPlan(command.pid);
      if (!plan) {
        return {
          message: `PID ${command.pid} is not in the monitored process list`,
          level: 'error',
        };
      }
      const proc = plan.target;
      const attached =
        proc.host && proc.host !== 'detached' ? ` It is attached to ${sanitize(proc.host)}.` : '';
      if (plan.alsoEnds.length > 0) {
        // The question stays short and the processes go into lines of their own: the question is
        // one line in the full-screen view, and a list in it was cut off at the terminal width
        const others = plan.alsoEnds;
        const confirmations = others.map((p) => ({ pid: p.pid, firstSeenAt: p.firstSeenAt }));
        const count = `${others.length} process${others.length === 1 ? '' : 'es'}`;
        return {
          message: '',
          level: 'warn',
          confirm: {
            // Short enough that [y/N] stays visible at 80 columns
            prompt: `End PID ${proc.pid} and the ${count} it started (${sumMemory([proc, ...others])})?`,
            details: [
              `${describeForConfirmation(proc)}${proc.host && proc.host !== 'detached' ? `  attached to ${sanitize(proc.host)}` : ''}`,
              ...others.map(describeForConfirmation),
            ],
            run: () => {
              const result = session.killProcess(proc.pid, { firstSeenAt: proc.firstSeenAt, also: confirmations });
              if (!result.ok) return { message: result.error, level: 'error' };
              const ended = result.alsoEnded?.length ?? 0;
              const endedText = `${ended} process${ended === 1 ? '' : 'es'} it started`;
              const parts = [
                result.targetSignalled === false
                  ? `PID ${proc.pid}: nothing sent (gone, another process now, or not permitted); sent SIGTERM to the ${endedText}`
                  : `Sent SIGTERM to PID ${proc.pid} and the ${endedText}`,
              ];
              const left = result.leftRunning ?? [];
              if (left.length > 0) parts.push(`PID ${left.join(', ')} ${left.length === 1 ? 'was' : 'were'} not in the confirmation and ${left.length === 1 ? 'keeps' : 'keep'} running`);
              const gone = result.notFound ?? [];
              if (gone.length > 0) parts.push(`PID ${gone.join(', ')} had exited or no longer ${gone.length === 1 ? 'belongs' : 'belong'} to the session, nothing sent`);
              const failed = result.failed ?? [];
              if (failed.length > 0) parts.push(`PID ${failed.join(', ')}: nothing sent (gone, another process now, or not permitted)`);
              return { message: parts.join('; '), level: left.length > 0 || failed.length > 0 ? 'warn' : 'info' };
            },
          },
        };
      }
      const agentNote = proc.category === 'agent' ? ' Its agent session ends.' : '';
      return {
        message: '',
        level: 'warn',
        confirm: {
          // Short, so that [y/N] stays visible at 80 columns; what the process is goes into its own lines
          prompt: `Terminate PID ${proc.pid} (${formatMemory(proc.memoryMb, proc.memorySource !== 'footprint', 0)})?${agentNote}`,
          details: [`${describeForConfirmation(proc)}${attached ? `  attached to ${sanitize(proc.host)}` : ''}`, `  ${sanitize(proc.cmd)}`],
          run: () => {
            const result = session.killProcess(proc.pid, { firstSeenAt: proc.firstSeenAt });
            return result.ok
              ? { message: `Sent SIGTERM to PID ${proc.pid}`, level: 'info' }
              : { message: result.error, level: 'error' };
          },
        },
      };
    }

    case 'pause': {
      const targets = session.getPauseTargets();
      if (targets.length === 0) {
        return { message: 'No agent of this repo is running, nothing to pause', level: 'info' };
      }
      return {
        message: '',
        level: 'warn',
        confirm: {
          // What the agents start while the question is open is held too: said here, named after.
          // Short, so that [y/N] stays visible at 80 columns
          prompt: `Pause ${targets.length} process${targets.length === 1 ? '' : 'es'} of this repo's agents and what they start meanwhile?`,
          details: targets.map(describePauseTarget),
          effect: 'hold',
          run: () => {
            // What was shown, each still the same process, and what those agents started while the
            // question was open; a new agent is asked about first, by the next pause
            const { pids, gone = [], notAsked, alsoHeld = [] } = session.pause(targets);
            // A reused PID is in both lists: it counts as gone, not as new
            const fresh = (notAsked ?? []).filter((pid) => !gone.includes(pid));
            const parts = [
              pids.length > 0
                ? `Paused ${pids.length} process${pids.length === 1 ? '' : 'es'}; type resume to continue`
                : 'Nothing was paused',
            ];
            if (alsoHeld.length > 0) {
              parts.push(`PID ${alsoHeld.join(', ')}, started by the agents after the question, ${alsoHeld.length === 1 ? 'is' : 'are'} held too`);
            }
            if (gone.length > 0) {
              parts.push(`PID ${gone.join(', ')} had exited or ${gone.length === 1 ? 'is another process' : 'are other processes'} now, not held`);
            }
            if (fresh.length > 0) {
              parts.push(`PID ${fresh.join(', ')} started after the question and ${fresh.length === 1 ? 'keeps' : 'keep'} running: type pause again to hold ${fresh.length === 1 ? 'it' : 'them'}`);
            }
            return { message: parts.join('; '), level: 'warn' };
          },
        },
      };
    }

    case 'resume': {
      // Continuing what strayps itself held is not destructive: no confirmation
      const { pids } = session.resume();
      return pids.length > 0
        ? { message: `Resumed ${pids.length} process${pids.length === 1 ? '' : 'es'}`, level: 'info' }
        : { message: 'Nothing is paused', level: 'info' };
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

/** Tab completion: command names and monitored PIDs. */
export function completeInput(session: MonitorSession, input: string): Completion {
  const spaceAt = input.search(/\s/);
  let head = '';
  let partial = input;
  let pool: string[] = COMMAND_NAMES;

  if (spaceAt !== -1) {
    const word = input.slice(0, spaceAt).toLowerCase();
    head = input.slice(0, spaceAt + 1);
    partial = input.slice(spaceAt + 1).replace(/^\s+/, '');
    const snapshot = session.getSnapshot();
    if (word === 'kill' || word === 'k') {
      pool = snapshot.processes.map((p) => String(p.pid));
    } else {
      return { input, candidates: [] };
    }
  }

  let matches = pool.filter((candidate) => candidate.startsWith(partial));
  if (matches.length === 0 && partial.length > 0 && head) {
    // A PID is easier to hit by any part of it than by its start
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
