import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs hook script without type declarations
import { decide, parseInvocation } from '../scripts/agents/leash-guard.mjs';

const repo = path.resolve(__dirname, '..');
const guard = (command: string, cwd = repo) =>
  decide({ command, cwd, projectDir: repo }) as { decision: string; reason: string } | null;

describe('leash-guard hook (scripts/agents/leash-guard.mjs)', () => {
  it('asks before a kill or panic endpoint is called', () => {
    for (const command of [
      'curl -X POST http://localhost:4321/api/panic',
      "curl -s -X POST 'http://127.0.0.1:4321/api/kill/1234' -H \"X-Leash-Token: $T\"",
      'curl -XPOST localhost:4321/api/kill-frozen',
      `node -e "fetch('http://localhost:4321/api/panic',{method:'POST'})"`,
      'T=$(curl -s localhost:4321/ | grep token); curl -X POST -H "X-Leash-Token: $T" localhost:4321/api/kill/55',
    ]) {
      expect(guard(command)?.decision, command).toBe('ask');
    }
    expect(guard('curl -X POST http://localhost:4321/api/panic')?.reason).toContain('--demo');
  });

  it('asks before the watchdog is started on this repository with auto-rollback on', () => {
    for (const command of [
      'node dist/cli.js watch',
      'node dist/cli.js watch .',
      'node dist/cli.js',
      'npx tsx src/cli.ts watch --port 4400',
      'tsx src/cli.ts . --mode strict',
      'agent-leash watch src',
      `agent-leash watch ${repo}`,
      'npx agent-leash',
      'node dist/cli.js watch . > /tmp/out.log 2>&1 &',
    ]) {
      expect(guard(command)?.decision, command).toBe('ask');
    }
    expect(guard('node dist/cli.js watch')?.reason).toContain('--no-auto-rollback');
  });

  it('has no objection to safe ways of running it', () => {
    for (const command of [
      'node dist/cli.js watch --demo',
      'node dist/cli.js --demo --port 4400',
      'node dist/cli.js watch . --no-auto-rollback',
      'npm run dev',
      'npm run demo',
      'node dist/cli.js status',
      'node dist/cli.js init /tmp/x --mode strict',
      'node dist/cli.js --version',
      'agent-leash --help',
      'node dist/cli.js watch /tmp/sandbox-repo',
      'node dist/cli.js watch "$SANDBOX/repo" --port 4400',
      'node "$CLI" watch "$REPO"',
      'node dist/cli.js watch ../some-other-project',
    ]) {
      expect(guard(command), command).toBeNull();
    }
  });

  it('stays out of the way of everything else', () => {
    for (const command of [
      'npm test',
      'npm run check',
      'git status',
      'curl -s http://localhost:4321/api/status',
      'curl -X POST http://localhost:4321/api/mode -d \'{"mode":"strict"}\'',
      'grep -rn "agent-leash" README.md',
      'cat src/cli.ts',
      'ls dist/cli.js',
      'echo "run agent-leash watch to start"',
      '',
    ]) {
      expect(guard(command), command).toBeNull();
    }
    expect(decide({ command: undefined })).toBeNull();
    expect(decide({ command: 42 })).toBeNull();
  });

  it('judges the target directory from where the command runs', () => {
    expect(guard('node /x/dist/cli.js watch .', '/tmp')).toBeNull();
    expect(guard('agent-leash watch', path.join(repo, 'src'))?.decision).toBe('ask');
    expect(guard(`agent-leash watch ${repo}/tests`, '/tmp')?.decision).toBe('ask');
  });

  it('reads the invocation the way the CLI would', () => {
    expect(parseInvocation('git status')).toBeNull();
    expect(parseInvocation('agent-leash')).toEqual({ watches: true, dir: null, safe: false });
    expect(parseInvocation('agent-leash watch ./app --port 5000 --mode strict')).toEqual({ watches: true, dir: './app', safe: false });
    expect(parseInvocation('agent-leash --port 5000 ./app')).toEqual({ watches: true, dir: './app', safe: false });
    expect(parseInvocation('agent-leash status ./app')).toEqual({ watches: false, dir: './app', safe: true });
    expect(parseInvocation('agent-leash watch --demo | tee log')).toEqual({ watches: true, dir: null, safe: true });
  });

  it('speaks the hook protocol: silent without objection, a JSON decision otherwise', () => {
    const run = (command: string) =>
      execFileSync(process.execPath, [path.join(repo, 'scripts/agents/leash-guard.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
        encoding: 'utf-8',
      });

    expect(run('npm test')).toBe('');
    const output = JSON.parse(run('curl -X POST localhost:4321/api/panic')) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('AGENTS.md');
  });
});
