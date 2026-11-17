import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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

describe('agent-leash CLI', () => {
  it('reports the version from package.json', async () => {
    const run = runCli(['--version']);
    expect(await run.exit).toEqual({ code: 0, signal: null });
    expect(run.output().trim()).toBe(packageVersion);
  });

  it('stops with a one-line error for a missing directory, a file, a bad mode and a bad port', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'a.ts': 'a\n' });
    const cases: Array<[string[], string]> = [
      [['watch', path.join(dir, 'missing')], 'Directory not found'],
      [['watch', path.join(dir, 'a.ts')], 'Not a directory'],
      [['watch', dir, '--mode', 'stricct'], 'Invalid --mode "stricct"'],
      [['watch', dir, '--port', 'banana'], 'Invalid --port "banana"'],
      [['watch', dir, '--port', '70000'], 'Invalid --port "70000"'],
      [['status', path.join(dir, 'missing')], 'Directory not found'],
    ];
    const runs = cases.map(([args]) => runCli(args));
    const results = await Promise.all(runs.map((run) => run.exit));

    cases.forEach(([args, message], index) => {
      const output = runs[index].output();
      expect(results[index], args.join(' ')).toEqual({ code: 1, signal: null });
      expect(output).toContain(`agent-leash: ${message}`);
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
    expect(run.output()).toContain('"exit" stops the watchdog');

    await run.waitFor('file-edit');
    run.child.stdin.write('exit\n');

    expect(await run.exit).toEqual({ code: 0, signal: null });
    expect(run.output()).toContain('Shutting down agent-leash watchdog (command)');
    expect(run.output()).toMatch(/agent-leash stopped after \d+s/);
    expect(run.output()).toMatch(/\d+ file edits · \d+ protected-file alerts/);
  });

  it('shows file edits, alerts and command results as log lines', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);

    await run.waitFor(/WARN {2}protected-file {5}WARNING: Protected ENV file change \(\.env\.local\)/);
    await run.waitFor(/CRIT {2}loop-detected {6}Circuit Breaker! Thrashing on src\/auth\/session\.ts/);
    await run.waitFor('rollback simulated');

    run.child.stdin.write('status\n');
    await run.waitFor(/31877\s+STALE\s+SAFE TO KILL/);
    run.child.stdin.write('clean\n');
    await run.waitFor('Type "yes" to confirm');
    run.child.stdin.write('yes\n');
    await run.waitFor('Sent SIGTERM to 2 processes');
    run.child.stdin.write('mode strict\n');
    await run.waitFor('Guard mode is now STRICT');
    run.child.stdin.write('quit\n');
    expect((await run.exit).code).toBe(0);
  });

  it('keeps running when its input closes, and stops cleanly on SIGINT, SIGTERM and SIGHUP', async () => {
    const dir = makeTmpDir();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
      await run.waitFor(READY);
      run.child.stdin.end();
      await run.waitFor('file-edit');
      expect(run.child.exitCode, 'still running after stdin closed').toBeNull();

      run.child.kill(signal);
      expect(await run.exit, signal).toEqual({ code: 0, signal: null });
      expect(run.output()).toContain(`Shutting down agent-leash watchdog (${signal})`);
      expect(run.output()).toContain('agent-leash stopped after');
    }
  });

  it('really guards a real directory: edits appear, protected files are reverted', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'docker-compose.yml': 'version: "3.8"\n', 'src/a.ts': 'a\n' });
    // --quiet: only alerts; the process list of this machine is read but never acted on
    const run = runCli(['watch', dir, '--no-dashboard', '--quiet']);
    await run.waitFor(READY);
    await new Promise((resolve) => setTimeout(resolve, 150));

    writeFiles(dir, { 'docker-compose.yml': 'version: "tampered"\n' });
    await run.waitFor('Protected file touched: docker-compose.yml (auto-reverted)');
    expect(read(dir, 'docker-compose.yml')).toBe('version: "3.8"\n');

    run.child.stdin.write('exit\n');
    expect((await run.exit).code).toBe(0);
    const kept = run.output().match(/kept in (\S+agent-leash-discarded-\S+)/)?.[1];
    expect(kept).toBeTruthy();
    fs.rmSync(kept!, { recursive: true, force: true });
  });

  it('refuses an explicitly chosen port that is taken, and moves on from the default one', async () => {
    const blocker = http.createServer((_req, res) => res.end('other app'));
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const dir = makeTmpDir();

    const strict = runCli(['watch', dir, '--demo', '--port', String(taken)]);
    expect(await strict.exit).toEqual({ code: 1, signal: null });
    expect(strict.output()).toContain(`agent-leash: Port ${taken} is already in use`);
    expect(strict.output()).not.toMatch(/\n\s+at /);
  });

  it('serves the dashboard on the loopback interface only', async () => {
    const dir = makeTmpDir();
    const run = runCli(['watch', dir, '--demo', '--port', '0']);
    await run.waitFor(/Dashboard: {3}http:\/\/localhost:\d+/);
    const port = Number(run.output().match(/Dashboard: {3}http:\/\/localhost:(\d+)/)![1]);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);
    const panic = await fetch(`http://127.0.0.1:${port}/api/panic`, { method: 'POST' });
    expect(panic.status).toBe(403);

    run.child.kill('SIGINT');
    expect((await run.exit).code).toBe(0);
  });

  it('creates a config file once and never overwrites it unasked', async () => {
    const dir = makeTmpDir();
    const first = runCli(['init', dir, '--mode', 'strict']);
    expect((await first.exit).code).toBe(0);
    expect(JSON.parse(read(dir, '.agentguard.json')).mode).toBe('strict');

    writeFiles(dir, { '.agentguard.json': '{"mode":"strict","protectedFiles":["secrets/**"]}\n' });
    const second = runCli(['init', dir]);
    expect((await second.exit).code).toBe(1);
    expect(second.output()).toContain('already exists');
    expect(read(dir, '.agentguard.json')).toContain('secrets/**');

    const forced = runCli(['init', dir, '--force', '--mode', 'yolo']);
    expect((await forced.exit).code).toBe(0);
    expect(JSON.parse(read(dir, '.agentguard.json'))).toMatchObject({ mode: 'yolo', protectedFiles: ['.env*', 'docker-compose*.yml', '.git/**'] });

    const badMode = runCli(['init', makeTmpDir(), '--mode', 'nonsense']);
    expect((await badMode.exit).code).toBe(1);
  });

  it('tells the user about problems in the config file at startup', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.agentguard.json': '{"mode":"turbo","limits":{"maxEditsPerFilePerMinute":-1}}' });
    const run = runCli(['watch', dir, '--demo', '--no-dashboard']);
    await run.waitFor(READY);
    await run.waitFor('mode "turbo" is not one of strict | balanced | yolo');
    expect(run.output()).toContain('limits.maxEditsPerFilePerMinute must be a number >= 1 (got -1), using 5');
    expect(run.output()).toContain('loop=5/min');
    run.child.kill('SIGINT');
    await run.exit;
  });
});

describe('agent-leash as a library', () => {
  it('can be imported without starting anything', () => {
    for (const name of [
      'GuardConfigManager',
      'LoopDetector',
      'ProcessMonitor',
      'RepoWatcher',
      'WatchdogSession',
      'createWatchdogApp',
      'startWatchdogServer',
      'listenWatchdogServer',
      'createCliProgram',
      'runCli',
      'TerminalUI',
      'PlainReporter',
      'renderFrame',
      'getVersion',
    ]) {
      expect(library, name).toHaveProperty(name);
    }
    expect(library.getVersion()).toBe(packageVersion);
    expect(library.createCliProgram().commands.map((c) => c.name()).sort()).toEqual(['init', 'status', 'watch']);
  });
});
