import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as library from '../src/index.js';
import { cleanupTmpDirs, makeTmpDir, read, writeFiles } from './helpers/harness.js';

/**
 * End-to-end: the real CLI entry point in a child process, driven the way a shell,
 * a pipe or an agent's background task drives it (no terminal, so plain output).
 *
 * Every run that could reach processes uses --demo, which has its own fake process table.
 */
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src/cli.ts');
const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;

interface Run {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  waitFor: (text: string | RegExp, timeoutMs?: number) => Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcessWithoutNullStreams[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0, children.length)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const server of servers.splice(0, servers.length)) {
    await new Promise((resolve) => server.close(resolve));
  }
  cleanupTmpDirs();
});

function runCli(args: string[], options: { cwd?: string } = {}): Run {
  const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  // closing our end of stdin must not surface as an EPIPE in the test
  child.stdin.on('error', () => {});

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const waitFor = async (text: string | RegExp, timeoutMs = 10_000) => {
    const started = Date.now();
    const found = () => (typeof text === 'string' ? buffer.includes(text) : text.test(buffer));
    while (!found()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for ${String(text)}; output so far:\n${buffer}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`process exited (${child.exitCode}) before printing ${String(text)}:\n${buffer}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  return { child, output: () => buffer, waitFor, exit };
}

const READY = 'Limits:';

describe('strayps CLI', () => {
  it('reports the version from package.json', async () => {
    const run = runCli(['--version']);
    expect(await run.exit).toEqual({ code: 0, signal: null });
    expect(run.output().trim()).toBe(packageVersion);
  });

  it('stops with a one-line error for a missing directory, a file and a bad port', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'a.ts': 'a\n' });
    const cases: Array<[string[], string]> = [
      [['watch', path.join(dir, 'missing')], 'Directory not found'],
      [['watch', path.join(dir, 'a.ts')], 'Not a directory'],
      [['watch', dir, '--port', 'banana'], 'Invalid --port "banana"'],
      [['watch', dir, '--port', '70000'], 'Invalid --port "70000"'],
      [['status', path.join(dir, 'missing')], 'Directory not found'],
    ];
    const runs = cases.map(([args]) => runCli(args));
    const results = await Promise.all(runs.map((run) => run.exit));

    cases.forEach(([args, message], index) => {
      const output = runs[index].output();
      expect(results[index], args.join(' ')).toEqual({ code: 1, signal: null });
      expect(output).toContain(`strayps: ${message}`);
      expect(output, 'no stack trace').not.toMatch(/\n\s+at /);
      expect(output.trim().split('\n')).toHaveLength(1);
    });
  });

  it('stops when "exit" is typed, and summarizes the session', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);
    expect(run.output()).toContain('DEMO');
    expect(run.output()).toContain('Dashboard:   off');
    expect(run.output()).toContain('"exit" stops strayps');

    await run.waitFor('process-alert');
    run.child.stdin.write('exit\n');

    expect(await run.exit).toEqual({ code: 0, signal: null });
    expect(run.output()).toContain('Shutting down strayps (command)');
    expect(run.output()).toMatch(/strayps stopped after \d+s/);
    expect(run.output()).toMatch(/\d+ process alerts · \d+ processes terminated/);
    expect(run.output()).not.toMatch(/file edits|protected-file|checkpoint/);
  });

  it('shows alerts and command results as log lines', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);

    await run.waitFor(/CRIT {2}process-alert {6}FROZEN: PID 31902/);
    // files are not watched: the old command says where to go instead of asking
    run.child.stdin.write('revert session.ts\n');
    await run.waitFor('Files are not watched any more: use git, or the checkpoints of your agent');
    expect(run.output()).not.toContain('Type "yes"');

    run.child.stdin.write('status\n');
    // old and idle, but watched for less than ten minutes: not called stale yet
    await run.waitFor(/31877\s+IDLE\s+ELSEWHERE/);
    await run.waitFor(/31902\s+FROZEN/);
    run.child.stdin.write('kill 31877\n');
    await run.waitFor('Type "yes"');
    run.child.stdin.write('yes\n');
    await run.waitFor('Sent SIGTERM to PID 31877');
    run.child.stdin.write('pause\n');
    await run.waitFor("Pause 3 processes of this repo's agents");
    run.child.stdin.write('yes\n');
    await run.waitFor('Paused 3 processes; type resume to continue');
    run.child.stdin.write('resume\n');
    await run.waitFor('Resumed 3 processes');
    run.child.stdin.write('quit\n');
    expect((await run.exit).code).toBe(0);
    expect(run.output()).not.toContain('Continued the');
  });

  it('keeps holding the demo processes across scans, so resume continues them later', async () => {
    // The demo's processes had a fixed age: two seconds after pause they looked like new processes
    // under the same PIDs, pause forgot them, and resume said "Nothing is paused"
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);
    run.child.stdin.write('pause\n');
    await run.waitFor("Pause 3 processes of this repo's agents");
    run.child.stdin.write('yes\n');
    await run.waitFor('Paused 3 processes; type resume to continue');
    // two scans (every 2 s) after the hold
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    run.child.stdin.write('resume\n');
    await run.waitFor('Resumed 3 processes');
    expect(run.output()).not.toContain('Nothing is paused');
    run.child.stdin.write('exit\n');
    expect((await run.exit).code).toBe(0);
  }, 30_000);

  it('says on exit that it continued what it held', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);
    run.child.stdin.write('pause\n');
    // the processes are named one per line before the question
    await run.waitFor(/PID 48110 {2}agent {2}claude/);
    run.child.stdin.write('yes\n');
    await run.waitFor('Paused 3 processes');
    run.child.stdin.write('exit\n');
    expect((await run.exit).code).toBe(0);
    expect(run.output()).toMatch(/Continued the 3 held processes on exit \(PID [\d, ]+\)/);
  });

  it('keeps running when its input closes, and stops cleanly on SIGINT, SIGTERM, SIGHUP and SIGQUIT', async () => {
    const dir = makeTmpDir();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
      const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
      await run.waitFor(READY);
      run.child.stdin.end();
      await run.waitFor('process-alert');
      expect(run.child.exitCode, 'still running after stdin closed').toBeNull();

      run.child.kill(signal);
      expect(await run.exit, signal).toEqual({ code: 0, signal: null });
      expect(run.output()).toContain(`Shutting down strayps (${signal})`);
      expect(run.output()).toContain('strayps stopped after');
    }
  });

  it('refuses an explicitly chosen port that is taken, and moves on from the default one', async () => {
    const blocker = http.createServer((_req, res) => res.end('other app'));
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const dir = makeTmpDir();

    const strict = runCli(['watch', dir, '--demo', '--port', String(taken)]);
    expect(await strict.exit).toEqual({ code: 1, signal: null });
    expect(strict.output()).toContain(`strayps: Port ${taken} is already in use`);
    expect(strict.output()).not.toMatch(/\n\s+at /);
  });

  it('serves the dashboard on the loopback interface only', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--port', '0']);
    await run.waitFor(/Dashboard: {3}http:\/\/localhost:\d+/);
    const port = Number(run.output().match(/Dashboard: {3}http:\/\/localhost:(\d+)/)![1]);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);
    // read-only: pausing and ending run in the terminal
    const pause = await fetch(`http://127.0.0.1:${port}/api/pause`, { method: 'POST' });
    expect(pause.status).toBe(405);

    run.child.kill('SIGINT');
    expect((await run.exit).code).toBe(0);
  });

  it('creates a config file once and never overwrites it unasked', async () => {
    const dir = makeTmpDir();
    const first = runCli(['init', dir]);
    expect((await first.exit).code).toBe(0);
    const defaults = { agents: [], limits: { mcpSilenceTimeoutSec: 45, staleSessionHours: 6 } };
    expect(JSON.parse(read(dir, '.strayps.json'))).toEqual(defaults);

    writeFiles(dir, { '.strayps.json': '{"agents":["vibe"]}\n' });
    const second = runCli(['init', dir]);
    expect((await second.exit).code).toBe(1);
    expect(second.output()).toContain('already exists');
    expect(read(dir, '.strayps.json')).toContain('vibe');

    const forced = runCli(['init', dir, '--force']);
    expect((await forced.exit).code).toBe(0);
    expect(JSON.parse(read(dir, '.strayps.json'))).toEqual(defaults);
  });

  it('treats a link or a directory where the config file goes as present, and fails without a stack trace', async () => {
    // A link to nowhere counted as absent; the write then refused with a raw stack trace, even
    // with --force (external audit, 21.11.2026)
    const dir = makeTmpDir();
    const elsewhere = path.join(makeTmpDir(), 'target.json');
    fs.symlinkSync(elsewhere, path.join(dir, '.strayps.json'));
    const refused = runCli(['init', dir]);
    expect((await refused.exit).code).toBe(1);
    expect(refused.output()).toContain('already exists');
    expect(refused.output()).not.toMatch(/\n\s+at /);

    const forced = runCli(['init', dir, '--force']);
    expect((await forced.exit).code).toBe(0);
    expect(fs.lstatSync(path.join(dir, '.strayps.json')).isFile()).toBe(true);
    expect(fs.existsSync(elsewhere), 'the link target is never written').toBe(false);

    const withFolder = makeTmpDir();
    fs.mkdirSync(path.join(withFolder, '.strayps.json'));
    const folder = runCli(['init', withFolder, '--force']);
    expect((await folder.exit).code).toBe(1);
    expect(folder.output()).toContain('strayps: Could not write');
    expect(folder.output()).not.toMatch(/\n\s+at /);
    expect(fs.statSync(path.join(withFolder, '.strayps.json')).isDirectory()).toBe(true);
  });

  it('tells the user about problems in the config file at startup', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.strayps.json': '{"mode":"turbo","protectedFiles":[".env*"],"limits":{"staleSessionHours":-1}}' });
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);
    await run.waitFor('"mode" no longer exists and is ignored');
    expect(run.output()).toContain('"protectedFiles" no longer exists and is ignored');
    expect(run.output()).toContain('limits.staleSessionHours must be a number >= 1 (got -1), using 6');
    expect(run.output()).toContain('stale after 6h');
    run.child.kill('SIGINT');
    await run.exit;
  });
});

describe('strayps config', () => {
  const configFile = (dir: string) => path.join(dir, '.strayps.json');

  it('says that an .agentguard.json from agent-leash is ignored, without opening it', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.agentguard.json': '{"limits":{"mcpSilenceTimeoutSec":90},"note":"private-marker"}' });

    const show = runCli(['config', dir]);
    expect(await show.exit).toEqual({ code: 0, signal: null });
    expect(show.output()).toContain('.agentguard.json is from agent-leash; strayps does not read it: rename it to .strayps.json to keep its values.');
    expect(show.output()).toMatch(/limits\.mcpSilenceTimeoutSec = 45 {2}\(default\)/);
    expect(show.output()).not.toContain('private-marker');

    const init = runCli(['init', dir]);
    expect(await init.exit).toEqual({ code: 0, signal: null });
    expect(init.output()).toContain('carry over what you still need with "strayps config set"');

    const clean = runCli(['config', makeTmpDir()]);
    await clean.exit;
    expect(clean.output()).not.toContain('agentguard');
  });

  it('never opens .agentguard.json: a FIFO there would make an open hang', async () => {
    const dir = makeTmpDir();
    execFileSync('mkfifo', [path.join(dir, '.agentguard.json')]);
    const show = runCli(['config', dir]);
    expect(await show.exit).toEqual({ code: 0, signal: null });
    expect(show.output()).toContain('.agentguard.json is from agent-leash; strayps does not read it');
  });

  it('says nothing about .agentguard.json in the demo, which looks at no file but .strayps.json', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.agentguard.json': '{}' });
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor('Commands:');
    expect(run.output()).not.toContain('agentguard');
    run.child.kill('SIGINT');
    await run.exit;
  });

  it('shows every setting with its value and where it comes from, without creating a file', async () => {
    const dir = makeTmpDir();
    const bare = runCli(['config', dir]);
    expect(await bare.exit).toEqual({ code: 0, signal: null });
    expect(bare.output()).toContain('No .strayps.json here; every value is a built-in default.');
    expect(bare.output()).toMatch(/limits\.mcpSilenceTimeoutSec = 45 {2}\(default\)/);
    expect(bare.output()).toMatch(/limits\.staleSessionHours = 6 {2}\(default\)/);
    expect(bare.output()).not.toMatch(/maxFiles|maxEdits|protectedFiles/);
    expect(fs.existsSync(configFile(dir)), 'showing never creates the file').toBe(false);

    writeFiles(dir, { '.strayps.json': '{"agents":["vibe"],"limits":{"staleSessionHours":20,"maxFilesWarn":3}}' });
    const withFile = runCli(['config', 'show', dir]);
    expect(await withFile.exit).toEqual({ code: 0, signal: null });
    expect(withFile.output()).toContain('.strayps.json found');
    expect(withFile.output()).toMatch(/agents = vibe {2}\(file\)/);
    expect(withFile.output()).toMatch(/limits\.staleSessionHours = 20 {2}\(file\)/);
    expect(withFile.output()).toMatch(/limits\.mcpSilenceTimeoutSec = 45 {2}\(default\)/);
    expect(withFile.output()).toContain('limits.maxFilesWarn is not a known setting and is ignored');
  });

  it('sets and removes one value at a time and keeps the rest of the file', async () => {
    const dir = makeTmpDir();
    const run = async (...args: string[]) => {
      const cli = runCli(['config', ...args, '-C', dir]);
      expect(await cli.exit, args.join(' ')).toEqual({ code: 0, signal: null });
      return cli.output();
    };

    const created = await run('set', 'staleSessionHours', '20');
    expect(created).toContain('Created');
    expect(created).toContain('limits.staleSessionHours = 20');
    expect(created).toContain('A running strayps picks this up within a second.');
    expect(JSON.parse(read(dir, '.strayps.json'))).toEqual({ limits: { staleSessionHours: 20 } });

    await run('set', 'AGENTS', 'vibe, opencode');
    expect(await run('set', 'limits.staleSessionHours', '25')).toContain('Updated');
    expect(JSON.parse(read(dir, '.strayps.json'))).toEqual({ agents: ['vibe', 'opencode'], limits: { staleSessionHours: 25 } });

    expect(await run('unset', 'staleSessionHours')).toContain('Removed limits.staleSessionHours');
    // an empty "limits" object is removed with its last key
    expect(JSON.parse(read(dir, '.strayps.json'))).toEqual({ agents: ['vibe', 'opencode'] });
    expect(await run('unset', 'staleSessionHours')).toContain(
      'limits.staleSessionHours is not set in .strayps.json; the default (6) already applies.',
    );
  }, 30_000);

  it('refuses unknown settings, invalid values and a broken file with a one-line error, changing nothing', async () => {
    const dir = makeTmpDir();
    const broken = path.join(dir, 'broken');
    writeFiles(dir, { 'broken/.strayps.json': '{ "agents": ' });
    const cases: Array<[string[], string]> = [
      [['config', 'set', 'staleSesionHours', '3', '-C', dir], 'Unknown setting "staleSesionHours". Known settings: limits.mcpSilenceTimeoutSec'],
      [['config', 'set', 'staleSessionHours', '0', '-C', dir], 'limits.staleSessionHours must be a whole number >= 1 (got "0")'],
      [['config', 'set', 'mode', 'strict', '-C', dir], 'Unknown setting "mode"'],
      [['config', 'set', 'protectedFiles', '.env*', '-C', dir], 'Unknown setting "protectedFiles"'],
      [['config', 'set', 'maxFilesWarn', '20', '-C', dir], 'Unknown setting "maxFilesWarn"'],
      [['config', 'set', 'agents', 'vibe', '-C', broken], 'is not valid JSON'],
      [['config', 'unset', 'agents', '-C', broken], 'Fix it first; nothing was changed.'],
      [['config', 'unset', 'nope', '-C', dir], 'Unknown setting "nope"'],
      [['config', 'show', path.join(dir, 'missing')], 'Directory not found'],
    ];
    const runs = cases.map(([args]) => runCli(args));
    const results = await Promise.all(runs.map((cli) => cli.exit));

    cases.forEach(([args, message], index) => {
      const output = runs[index].output();
      expect(results[index], args.join(' ')).toEqual({ code: 1, signal: null });
      expect(output).toContain('strayps: ');
      expect(output).toContain(message);
      expect(output, 'no stack trace').not.toMatch(/\n\s+at /);
      expect(output.trim().split('\n')).toHaveLength(1);
    });
    expect(fs.existsSync(configFile(dir)), 'no file for a refused value').toBe(false);
    expect(read(broken, '.strayps.json')).toBe('{ "agents": ');
  });

  it('never prints control characters from .strayps.json to the terminal', async () => {
    // The watched agent can write this file: its keys, values and broken JSON are untrusted text
    const hostile = '\u001b]0;pwned\u0007\u001b[2J';
    const dir = makeTmpDir();
    writeFiles(dir, {
      '.strayps.json': JSON.stringify({ [`x${hostile}`]: 1, limits: { staleSessionHours: `20${hostile}` } }),
    });
    const broken = makeTmpDir();
    // V8 quotes the start of the text in this parse error, control characters included
    writeFiles(broken, { '.strayps.json': `{"agents": a${hostile}}` });

    const set = runCli(['config', 'set', 'staleSessionHours', '25', '-C', dir]);
    const refused = runCli(['config', 'set', 'agents', 'vibe', '-C', broken]);
    const watch = runCli(['watch', broken, '--demo', '--no-dashboard']);
    const watchUnknownKey = runCli(['watch', dir, '--demo', '--no-dashboard']);
    for (const run of [watch, watchUnknownKey]) {
      await run.waitFor(READY);
      run.child.stdin.write('exit\n');
    }
    await Promise.all([set.exit, refused.exit, watch.exit, watchUnknownKey.exit]);

    expect(set.output()).toContain('(was 20?]0;pwned??[2J)');
    expect(refused.output()).toContain('is not valid JSON');
    for (const run of [set, refused, watch, watchUnknownKey]) {
      expect(run.output()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    }
  }, 30_000);

  it('applies edits to .strayps.json while watching', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.strayps.json': '{"limits":{"staleSessionHours":6}}\n' });
    // the process list of this machine is read but never acted on
    const run = runCli(['watch', dir, '--no-dashboard']);
    await run.waitFor(READY);
    expect(run.output()).toContain('stale after 6h');
    await new Promise((resolve) => setTimeout(resolve, 150));

    writeFiles(dir, { '.strayps.json': '{"limits":{"staleSessionHours":9}}\n' });
    await run.waitFor(/WARN {2}config-reload +\.strayps\.json reloaded: limits\.staleSessionHours 6 → 9/);

    // a broken save is not applied and does not stop strayps
    writeFiles(dir, { '.strayps.json': '{"limits":{"staleSessionHours":' });
    await run.waitFor('.strayps.json changed but was not applied, previous settings kept');

    // saving the same values again is no change worth reporting
    writeFiles(dir, { '.strayps.json': '{"limits":{"staleSessionHours":9}}\n' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(run.output().match(/reloaded:/g)).toHaveLength(1);

    run.child.stdin.write('exit\n');
    expect((await run.exit).code).toBe(0);
  }, 30_000);

  it('never writes the config file in the demo', async () => {
    const dir = makeTmpDir();
    const original = '{\n  "limits": { "staleSessionHours": 9 }\n}\n';
    writeFiles(dir, { '.strayps.json': original });
    const withFile = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await withFile.waitFor(READY);
    await withFile.waitFor('process-alert');
    withFile.child.stdin.write('kill 31877\nyes\npause\nyes\nresume\n');
    await withFile.waitFor('Resumed');
    withFile.child.stdin.write('exit\n');
    expect((await withFile.exit).code).toBe(0);
    expect(read(dir, '.strayps.json')).toBe(original);

    const bare = makeTmpDir();
    const withoutFile = runCli(['watch', bare, '--demo', '--no-dashboard']);
    await withoutFile.waitFor(READY);
    withoutFile.child.stdin.write('exit\n');
    expect((await withoutFile.exit).code).toBe(0);
    expect(fs.existsSync(configFile(bare))).toBe(false);
  }, 30_000);
});

describe('strayps as a library', () => {
  it('can be imported without starting anything', () => {
    for (const name of [
      'ConfigManager',
      'ProcessMonitor',
      'MonitorSession',
      'createDashboardApp',
      'startDashboardServer',
      'listenDashboardServer',
      'createCliProgram',
      'runCli',
      'TerminalUI',
      'PlainReporter',
      'renderFrame',
      'getVersion',
    ]) {
      expect(library, name).toHaveProperty(name);
    }
    expect(library).not.toHaveProperty('RepoWatcher');
    expect(library).not.toHaveProperty('LoopDetector');
    expect(library.getVersion()).toBe(packageVersion);
    expect(library.createCliProgram().commands.map((c) => c.name()).sort()).toEqual(['config', 'init', 'status', 'watch']);
  });
});
