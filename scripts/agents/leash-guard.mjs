// Guard for coding agents working ON agent-leash (AGENTS.md, section 2).
//
// agent-leash terminates processes for a living. One command is easy to type while developing it
// and expensive to get wrong: calling a kill or panic endpoint of a running instance. Against an
// instance that was started without --demo it terminates real agent sessions (including the one
// running the command) and rolls files back. The user is asked first.
//
// Starting the watchdog on this repository needs no guard any more: it never rolls a file back
// on its own, only after a person confirmed a revert or panic.
//
// Everything else is left to the normal permission flow: this script prints a decision only when
// it has an objection.
//
//   Claude Code: PreToolUse hook in .claude/settings.json (matcher Bash)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// kill-frozen no longer exists, but an instance from an older build may still answer it
const KILL_ENDPOINT = /\/api\/(panic|kill-frozen|kill\/[^\s'"]*)/;

/**
 * Decision for one shell command.
 * @param {{ command?: unknown }} call
 * @returns {{ decision: 'ask', reason: string } | null}  null: no objection
 */
export function decide({ command }) {
  if (typeof command !== 'string' || command.trim() === '') return null;

  if (KILL_ENDPOINT.test(command)) {
    return {
      decision: 'ask',
      reason:
        'This calls a kill or panic endpoint of a running agent-leash instance. Unless that instance was started with --demo, it terminates real agent sessions (this one included) and rolls files back. For tests use tests/helpers/harness.ts (fake process table) instead. See AGENTS.md, section 2.',
    };
  }
  return null;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const result = decide({ command: input.tool_input?.command });
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
