// Guard for coding agents working ON agent-leash (AGENTS.md, section 2).
//
// agent-leash terminates processes and rewrites files for a living. Two commands are easy to
// type while developing it and expensive to get wrong:
//
//   1. Calling a kill or panic endpoint of a running instance. Against an instance that was
//      started without --demo this terminates real agent sessions (including the one running
//      the command) and rolls files back.
//   2. Starting the watchdog on this repository with auto-rollback on. It then reverts the
//      very files the agent is editing as soon as the circuit breaker trips.
//
// For both the user is asked first. Everything else is left to the normal permission flow:
// this script prints a decision only when it has an objection.
//
//   Claude Code: PreToolUse hook in .claude/settings.json (matcher Bash)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KILL_ENDPOINT = /\/api\/(panic|kill-frozen|kill\/[^\s'"]*)/;
const TOKEN = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&()<>]+|[;|&()<>]+/g;
const OPERATOR = /^[;|&()<>]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'exec', 'time', 'nohup', 'env', 'command']);
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const SCRIPT_RUNNERS = new Set(['node', 'tsx', 'bun', 'ts-node']);
const RUNNER_OPTIONS_WITH_VALUE = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
const OPTIONS_WITH_VALUE = new Set(['-p', '--port', '-m', '--mode']);
const OTHER_COMMANDS = new Set(['status', 'init', 'help']);

/** @param {string} token */
const unquote = (token) => token.replace(/^(['"])([\s\S]*)\1$/, '$2');
/** @param {string} token */
const baseName = (token) => unquote(token).split('/').pop() ?? '';

/**
 * Splits a shell command line into its simple commands (token lists), cutting at
 * `;`, `&&`, `||`, `|`, `&`, redirections and parentheses.
 * @param {string} command
 * @returns {string[][]}
 */
function simpleCommands(command) {
  /** @type {string[][]} */
  const commands = [[]];
  for (const token of command.match(TOKEN) ?? []) {
    if (OPERATOR.test(token)) {
      // after a redirection the next token is a file name, not a command: drop it with the rest
      commands.push(/[<>]/.test(token) ? ['<redirect>'] : []);
    } else {
      commands[commands.length - 1].push(token);
    }
  }
  return commands.filter((tokens) => tokens.length > 0 && tokens[0] !== '<redirect>');
}

/**
 * If the tokens of one simple command start agent-leash, returns its arguments.
 * Only the command position counts: mentioning the name in an argument does not.
 * @param {string[]} tokens
 * @returns {string[] | null}
 */
function cliArguments(tokens) {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGNMENT.test(tokens[i]) || WRAPPERS.has(baseName(tokens[i])))) i++;
  if (i < tokens.length && PACKAGE_RUNNERS.has(baseName(tokens[i]))) {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) i++;
  }
  if (i >= tokens.length) return null;

  if (baseName(tokens[i]) === 'agent-leash') return tokens.slice(i + 1);

  if (SCRIPT_RUNNERS.has(baseName(tokens[i]))) {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += RUNNER_OPTIONS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
    }
    // `npx tsx src/cli.ts`: a script runner started through another one
    if (i < tokens.length && SCRIPT_RUNNERS.has(baseName(tokens[i]))) {
      return cliArguments(tokens.slice(i));
    }
    const script = i < tokens.length ? unquote(tokens[i]) : '';
    if (/(^|\/)(src\/cli\.ts|dist\/cli\.js|agent-leash)$/.test(script)) return tokens.slice(i + 1);
  }
  return null;
}

/**
 * Looks at the first agent-leash invocation in a shell command line.
 * @param {string} command
 * @returns {{ watches: boolean, dir: string | null, safe: boolean } | null}
 *   null: the command does not start agent-leash at all
 */
export function parseInvocation(command) {
  for (const tokens of simpleCommands(command)) {
    const args = cliArguments(tokens);
    if (!args) continue;

    let subcommand = null;
    let dir = null;
    let safe = false;
    for (let i = 0; i < args.length; i++) {
      const token = unquote(args[i]);
      if (token === '--demo' || token === '--no-auto-rollback') {
        safe = true;
        continue;
      }
      if (token === '--help' || token === '-h' || token === '--version' || token === '-V') {
        return { watches: false, dir: null, safe: true };
      }
      if (OPTIONS_WITH_VALUE.has(token)) {
        i += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      if (subcommand === null && (token === 'watch' || OTHER_COMMANDS.has(token))) {
        subcommand = token;
        continue;
      }
      if (dir === null) dir = token;
    }
    if (subcommand !== null && subcommand !== 'watch') {
      return { watches: false, dir, safe: true };
    }
    return { watches: true, dir, safe };
  }
  return null;
}

/**
 * Decision for one shell command.
 * @param {{ command?: unknown, cwd?: string, projectDir?: string }} call
 * @returns {{ decision: 'ask', reason: string } | null}  null: no objection
 */
export function decide({ command, cwd = process.cwd(), projectDir = cwd }) {
  if (typeof command !== 'string' || command.trim() === '') return null;

  if (KILL_ENDPOINT.test(command)) {
    return {
      decision: 'ask',
      reason:
        'This calls a kill or panic endpoint of a running agent-leash instance. Unless that instance was started with --demo, it terminates real agent sessions (this one included) and rolls files back. For tests use tests/helpers/harness.ts (fake process table) instead. See AGENTS.md, section 2.',
    };
  }

  const invocation = parseInvocation(command);
  if (invocation?.watches && !invocation.safe) {
    const target = invocation.dir ?? '.';
    // A path built from shell variables cannot be resolved here; those point at sandboxes.
    if (!/[$`]/.test(target)) {
      const resolved = path.resolve(cwd, target);
      const root = path.resolve(projectDir);
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return {
          decision: 'ask',
          reason:
            'This starts the watchdog on the agent-leash repository itself with auto-rollback on: it will revert the files you are editing when the circuit breaker trips. Add --no-auto-rollback or --demo, or watch a sandbox directory (scripts/scenarios/make-sandbox.sh). See AGENTS.md, section 2.',
        };
      }
    }
  }

  return null;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const result = decide({
    command: input.tool_input?.command,
    cwd: input.cwd,
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? input.cwd,
  });
  if (!result) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
