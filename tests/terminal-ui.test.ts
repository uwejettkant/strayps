import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeInput,
  parseCommand,
  resolveModifiedFile,
  runCommand,
} from '../src/ui/commands.js';
import {
  createPalette,
  formatEventLine,
  sanitize,
  shouldUseColor,
  truncate,
  truncateStart,
} from '../src/ui/format.js';
import { PlainReporter } from '../src/ui/plain.js';
import { type FrameView, renderFrame, TerminalUI } from '../src/ui/terminal.js';
import { cleanupTmpDirs, createHarness, type Harness, read, stripAnsi, writeFiles } from './helpers/harness.js';

afterEach(() => {
  cleanupTmpDirs();
  vi.useRealTimers();
});

const OTHER = '/work/other-repo';

/** A session with two modified files, one stale session elsewhere and one agent in the repo. */
async function busyHarness(): Promise<Harness> {
  const h = createHarness({
    files: { 'src/app.ts': 'app\n', 'src/api/client.ts': 'client\n', 'README.md': 'readme\n' },
    watcher: { keepDiscarded: false },
    procs: [
      { pid: 100, name: 'claude', cmd: 'claude --model claude-sonnet-5-5', cpu: 4, rssKb: 220_000, etime: '12:31' },
      { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 128_000, etime: '11-19:42:10' },
    ],
  });
  h.procs[0].cwd = h.dir;
  h.watcher.createCheckpoint();
  writeFiles(h.dir, { 'src/app.ts': 'changed\n', 'src/api/client.ts': 'changed\n' });
  h.watcher.handleFileSystemEvent('change', 'src/app.ts');
  h.watcher.handleFileSystemEvent('change', 'src/api/client.ts');
  await h.monitor.scan();
  return h;
}

describe('command parsing', () => {
  it('understands every way of saying "stop"', () => {
    for (const word of ['exit', 'quit', 'q', ':q', 'stop', 'bye', '  EXIT  ', 'Quit']) {
      expect(parseCommand(word), word).toEqual({ kind: 'exit' });
    }
  });

  it('parses the commands and their short forms', () => {
    expect(parseCommand('')).toEqual({ kind: 'empty' });
    expect(parseCommand('   ')).toEqual({ kind: 'empty' });
    expect(parseCommand('help')).toEqual({ kind: 'help' });
    expect(parseCommand('?')).toEqual({ kind: 'help' });
    expect(parseCommand('status')).toEqual({ kind: 'status' });
    expect(parseCommand('revert src/app.ts')).toEqual({ kind: 'revert', target: 'src/app.ts' });
    expect(parseCommand('r "my file.ts"')).toEqual({ kind: 'revert', target: 'my file.ts' });
    expect(parseCommand('rollback a b.ts')).toEqual({ kind: 'revert', target: 'a b.ts' });
    expect(parseCommand('kill 4711')).toEqual({ kind: 'kill', pid: 4711 });
    expect(parseCommand('k 12')).toEqual({ kind: 'kill', pid: 12 });
    expect(parseCommand('panic')).toEqual({ kind: 'panic' });
  });

  it('has no bulk cleanup, and says how to terminate one process instead', () => {
    for (const word of ['clean', 'cleanup']) {
      expect(parseCommand(word), word).toEqual({
        kind: 'invalid',
        message: 'There is no bulk cleanup: look at the list (status) and terminate one process with kill <pid>.',
      });
    }
  });

  it('explains what is wrong instead of guessing', () => {
    // there are no modes any more; the old words get an explanation
    for (const old of ['mode strict', 'mode', 'yolo', 'balanced']) {
      expect(parseCommand(old)).toMatchObject({ kind: 'invalid', message: expect.stringContaining('no modes any more') });
    }
    expect(parseCommand('revert')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('kill')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('kill -9 123')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('kill 12abc')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('rm -rf /')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('Unknown command') });
    const hostile = parseCommand('\u001b[2Jboom now');
    expect(hostile.kind).toBe('invalid');
    expect(JSON.stringify(hostile)).not.toContain('\\u001b');
  });

  it('finds the modified file the user means and refuses to guess between several', () => {
    const files = ['src/app.ts', 'src/api/client.ts', 'tests/app.ts'];
    expect(resolveModifiedFile('src/app.ts', files)).toEqual({ file: 'src/app.ts' });
    expect(resolveModifiedFile('./src/app.ts', files)).toEqual({ file: 'src/app.ts' });
    expect(resolveModifiedFile('client.ts', files)).toEqual({ file: 'src/api/client.ts' });
    expect(resolveModifiedFile('api', files)).toEqual({ file: 'src/api/client.ts' });
    expect(resolveModifiedFile('app.ts', files)).toMatchObject({ error: expect.stringContaining('matches 2') });
    expect(resolveModifiedFile('package.json', files)).toMatchObject({ error: expect.stringContaining('not a file modified') });
  });
});

describe('running commands against a session', () => {
  it('asks before every destructive command and does nothing until the answer is yes', async () => {
    const h = await busyHarness();

    const revert = runCommand(h.session, parseCommand('revert app.ts'));
    expect(revert.confirm?.prompt).toContain('src/app.ts');
    const kill = runCommand(h.session, parseCommand('kill 300'));
    expect(kill.confirm?.prompt).toContain('PID 300');
    expect(kill.confirm?.prompt).toContain('Its agent session ends.');
    expect(kill.confirm?.prompt).not.toMatch(/stale|safe/i);
    const panic = runCommand(h.session, parseCommand('panic'));
    expect(panic.confirm?.prompt).toBe(
      "PANIC: roll back 2 files changed in the last 10 min and stop 1 process of this repo's agents (claude 100)?",
    );

    // nothing happened yet
    expect(h.kills).toEqual([]);
    expect(read(h.dir, 'src/app.ts')).toBe('changed\n');

    expect(revert.confirm!.run()).toMatchObject({ level: 'info', message: 'Rolled back src/app.ts' });
    expect(read(h.dir, 'src/app.ts')).toBe('app\n');

    expect(kill.confirm!.run().message).toBe('Sent SIGTERM to PID 300');
    expect(h.kills).toEqual([{ pid: 300, signal: 'SIGTERM' }]);

    expect(panic.confirm!.run().message).toMatch(/^PANIC done: 1 file rolled back, 1 process killed$/);
    expect(h.kills.at(-1)).toEqual({ pid: 100, signal: 'SIGKILL' });
    expect(read(h.dir, 'src/api/client.ts')).toBe('client\n');
  });

  it('refuses targets that are not on the lists', async () => {
    const h = await busyHarness();
    for (const line of ['kill 4242', 'revert ../../etc/passwd', 'revert README.md']) {
      const result = runCommand(h.session, parseCommand(line));
      expect(result.level, line).toBe('error');
      expect(result.confirm, line).toBeUndefined();
    }
    expect(h.kills).toEqual([]);
  });

  it('says so when panic has no agent to stop', async () => {
    const h = createHarness();
    const panic = runCommand(h.session, parseCommand('panic'));
    expect(panic.confirm?.prompt).toBe('PANIC: roll back 0 files changed in the last 10 min (no agent of this repo is running)?');
    expect(runCommand(h.session, parseCommand('exit'))).toMatchObject({ exit: true });
    expect(runCommand(h.session, parseCommand('help'))).toMatchObject({ showHelp: true });
  });

  it('completes commands, modified files and PIDs', async () => {
    const h = await busyHarness();
    expect(completeInput(h.session, 'pa').input).toBe('panic ');
    expect(completeInput(h.session, 'revert src/app').input).toBe('revert src/app.ts');
    expect(completeInput(h.session, 'revert client').input).toBe('revert src/api/client.ts');
    expect(completeInput(h.session, 'kill 30').input).toBe('kill 300');

    const ambiguous = completeInput(h.session, 'revert src/');
    expect(ambiguous.input).toBe('revert src/ap');
    expect(ambiguous.candidates.sort()).toEqual(['src/api/client.ts', 'src/app.ts']);
    expect(completeInput(h.session, 'zz')).toEqual({ input: 'zz', candidates: [] });
    expect(completeInput(h.session, 'help x')).toEqual({ input: 'help x', candidates: [] });
  });
});

describe('text that reaches the terminal', () => {
  it('neutralizes escape sequences, control characters and bidi overrides', () => {
    const hostile = 'a\u001b[2J\u001b]0;pwned\u0007b\r\nc\u202egnp.exe\u0000\u009b31m';
    const clean = sanitize(hostile);
    expect(clean).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(clean).toContain('a?[2J');
    expect(sanitize(undefined)).toBe('');
    expect(sanitize(42)).toBe('42');
  });

  it('truncates by visible characters', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('äöü€😀x', 5)).toBe('äöü€…');
    expect(truncate('abc', 0)).toBe('');
    expect(truncateStart('/very/long/path/to/repo', 9)).toBe('…/to/repo');
    expect(truncateStart('short', 9)).toBe('short');
  });

  it('uses color only where it is wanted', () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(createPalette(false).danger('x')).toBe('x');
    expect(createPalette(true).danger('x')).toBe('\u001b[1;31mx\u001b[0m');
  });

  it('formats a log line without letting the message break out of it', () => {
    const line = formatEventLine(
      { id: '1', type: 'file-edit', severity: 'info', timestamp: new Date(2026, 10, 16, 9, 5, 7).getTime(), message: 'ADD: evil\nname\u001b[31m.ts' },
      createPalette(false),
    );
    expect(line).toBe('09:05:07  INFO  file-edit          ADD: evil?name?[31m.ts');
  });
});

describe('full-screen frame', () => {
  function viewFor(h: Harness, overrides: Partial<FrameView> = {}): FrameView {
    return {
      snapshot: h.session.getSnapshot(),
      cols: 120,
      rows: 34,
      version: '9.9.9',
      dashboardUrl: 'http://localhost:4321',
      demo: false,
      input: '',
      notice: null,
      confirmPrompt: null,
      overlay: null,
      palette: createPalette(false),
      now: new Date(2026, 10, 16, 10, 31, 2).getTime(),
      ...overrides,
    };
  }

  it('shows what the dashboard shows: files, breaker, events and processes', async () => {
    const h = await busyHarness();
    const frame = renderFrame(viewFor(h));
    const screen = frame.lines.join('\n');

    expect(frame.lines).toHaveLength(34);
    expect(screen).toContain('agent-leash v9.9.9');
    expect(screen).not.toMatch(/\bmode\b|balanced/i);
    expect(screen).toContain('dashboard http://localhost:4321');
    expect(screen).toContain('2 modified');
    expect(screen).toContain('warn 15 · stop 40');
    expect(screen).toContain('armed');
    expect(screen).toContain('2 monitored');
    expect(screen).toContain('1 stale/frozen');
    expect(screen).toContain('CHANGE: src/app.ts (1/5 edits/min)');
    expect(screen).toMatch(/300\s+STALE\s+ELSEWHERE\s+125\.0 MB\s+11d 19h/);
    expect(screen).toMatch(/100\s+ACTIVE\s+THIS REPO/);
    expect(screen).not.toMatch(/safe to kill|reclaimable/i);
    expect(screen).toContain('10:31:02');
    // oldest event first, like a log
    expect(screen.indexOf('checkpoint-created')).toBeLessThan(screen.indexOf('src/api/client.ts'));
  });

  it('never produces a line wider than the terminal, at any size', async () => {
    const h = await busyHarness();
    for (const [cols, rows] of [[200, 60], [120, 34], [100, 18], [80, 24], [58, 12], [40, 8], [20, 6], [10, 3]]) {
      const frame = renderFrame(viewFor(h, { cols, rows, palette: createPalette(true, true), input: 'x'.repeat(300) }));
      expect(frame.lines.length, `${cols}x${rows}`).toBe(Math.max(6, rows));
      for (const line of frame.lines) {
        expect(Array.from(stripAnsi(line)).length, `${cols}x${rows}: ${stripAnsi(line)}`).toBeLessThanOrEqual(Math.max(20, cols));
      }
      expect(frame.cursor.col).toBeLessThanOrEqual(Math.max(20, cols));
      expect(frame.cursor.row).toBeLessThanOrEqual(Math.max(6, rows));
    }
  });

  it('cannot be hijacked by file names or command lines', async () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      procs: [{ pid: 7, name: 'node', cmd: 'node mcp-server \u001b[2J\u001b[31mHACKED\u0007', cwd: '/tmp/\u001b]0;title\u0007', etime: '10:00' }],
    });
    h.watcher.createCheckpoint();
    h.watcher.handleFileSystemEvent('add', 'evil\u001b[2J\u001b[1;1H\rname.ts');
    await h.monitor.scan();

    const frame = renderFrame(viewFor(h));
    for (const line of frame.lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(frame.lines.join('\n')).toContain('evil?[2J?[1;1H?name.ts');
  });

  it('makes alarms unmissable: tripped breaker and hard stop', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 41; i++) files[`f${i}.ts`] = 'x\n';
    const h = createHarness({ files });
    h.watcher.createCheckpoint();
    for (let i = 0; i < 41; i++) h.watcher.handleFileSystemEvent('change', `f${i}.ts`);
    for (let i = 0; i < 6; i++) h.watcher.handleFileSystemEvent('change', 'f0.ts');

    const screen = renderFrame(viewFor(h)).lines.join('\n');
    expect(screen).toContain('HARD STOP limit reached');
    expect(screen).toContain('TRIPPED (1)');
    expect(screen).toContain('f0.ts');
  });

  it('shows the confirmation prompt, notices, help and the full process list', async () => {
    const h = await busyHarness();
    const confirm = renderFrame(viewFor(h, { confirmPrompt: 'Terminate PID 300?' }));
    expect(confirm.lines.at(-2)).toContain('? Terminate PID 300? [y/N]');
    expect(confirm.cursor.row).toBe(33);

    const notice = renderFrame(viewFor(h, { notice: { text: 'Sent SIGTERM to PID 300', level: 'info' }, input: 'kill 30' }));
    expect(notice.lines.at(-2)).toContain('Sent SIGTERM to PID 300');
    expect(notice.lines.at(-1)).toContain('› kill 30');
    expect(notice.cursor).toEqual({ row: 34, col: 11 });

    const help = renderFrame(viewFor(h, { overlay: 'help' })).lines.join('\n');
    expect(help).toContain('revert <file>');
    expect(help).toContain('always ask before they act');
    expect(help).not.toContain('ACTIVITY');

    const all = renderFrame(viewFor(h, { overlay: 'processes', rows: 14 })).lines.join('\n');
    expect(all).toContain('ALL PROCESSES');
    expect(all).toMatch(/300\s+STALE/);
    expect(all).toMatch(/100\s+ACTIVE/);
  });

  it('says so when nothing has happened and nothing is running', () => {
    const h = createHarness();
    const screen = renderFrame(viewFor(h, { dashboardUrl: null, demo: true })).lines.join('\n');
    expect(screen).toContain('No activity yet');
    expect(screen).toContain('No agent or MCP processes found.');
    expect(screen).toContain('dashboard off');
    expect(screen).toContain('DEMO');
  });
});

class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  rawMode: boolean | null = null;
  paused = true;
  written: string[] = [];
  setRawMode(mode: boolean) {
    this.rawMode = mode;
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  write(data: string) {
    this.written.push(data);
    return true;
  }
  get screen(): string {
    const last = [...this.written].reverse().find((chunk) => chunk.includes('\u001b[H')) ?? '';
    return stripAnsi(last);
  }
}

describe('interactive terminal view', () => {
  async function startUi(h?: Harness) {
    const harness = h ?? (await busyHarness());
    const tty = new FakeTty();
    const onExit = vi.fn();
    const ui = new TerminalUI({
      session: harness.session,
      stdin: tty,
      stdout: tty,
      version: '9.9.9',
      dashboardUrl: 'http://localhost:4321',
      color: false,
      onExit,
    });
    ui.start();
    const type = (text: string) => {
      ui.handleInput(text);
      ui.renderNow();
    };
    return { h: harness, tty, ui, onExit, type };
  }

  it('takes over the terminal on start and gives it back exactly as it was on stop', async () => {
    const { tty, ui } = await startUi();
    expect(tty.rawMode).toBe(true);
    expect(tty.paused).toBe(false);
    expect(tty.written[0]).toBe('\u001b[?1049h\u001b[?7l\u001b[2J\u001b[H');
    expect(tty.screen).toContain('agent-leash v9.9.9');

    ui.stop();
    expect(tty.rawMode).toBe(false);
    expect(tty.paused).toBe(true);
    expect(tty.written.at(-1)).toBe('\u001b[?7h\u001b[?25h\u001b[?1049l');
    expect(tty.listenerCount('data')).toBe(0);
    expect(tty.listenerCount('resize')).toBe(0);

    const writes = tty.written.length;
    ui.stop();
    ui.handleInput('exit\r');
    expect(tty.written.length).toBe(writes);
  });

  it('quits on exit, quit, q, Ctrl+C and Ctrl+D', async () => {
    for (const [keys, reason] of [['exit\r', 'command'], ['quit\r', 'command'], ['q\r', 'command'], ['\u0003', 'ctrl-c'], ['\u0004', 'ctrl-d']] as const) {
      const { ui, onExit, type } = await startUi();
      type(keys);
      expect(onExit, keys).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith(reason);
      type('\u0003');
      expect(onExit).toHaveBeenCalledTimes(1);
      ui.stop();
    }
  });

  it('quits on Ctrl+C from any state, and Ctrl+D only on an empty line', async () => {
    const { ui, onExit, type } = await startUi();
    type('kill 30');
    type('\u0004');
    expect(onExit).not.toHaveBeenCalled();
    type('0\r');
    expect(ui.isActive()).toBe(true);
    type('\u0003');
    expect(onExit).toHaveBeenCalledWith('ctrl-c');
    ui.stop();
  });

  it('edits the command line: typing, backspace, clear, history, pasted text', async () => {
    const { tty, ui, type, h } = await startUi();
    type('kill 30x');
    expect(tty.screen).toContain('› kill 30x');
    type('\u007f');
    type('0');
    expect(tty.screen).toContain('› kill 300');
    type('\r');
    expect(tty.screen).toContain('? Terminate PID 300');
    type('n');
    expect(h.kills).toEqual([]);

    type('\u001b[A');
    expect(tty.screen).toContain('› kill 300');
    type('\u0015');
    expect(tty.screen).not.toContain('› kill 300');
    type('abc def\u0017');
    expect(tty.screen).toContain('› abc');
    type('\u001b');
    expect(tty.screen).not.toContain('› abc');
    // arrow keys, function keys and mouse reports are not text
    type('\u001b[C\u001b[D\u001bOP\u001b[<0;10;10M');
    expect(tty.screen).toMatch(/› {5,}/);
    ui.stop();
  });

  it('asks y/N before destructive commands and treats everything but y as no', async () => {
    const { tty, ui, type, h } = await startUi();
    type('kill 300\r');
    expect(tty.screen).toContain('? Terminate PID 300');
    expect(tty.screen).toContain('[y/N]');
    type('n');
    expect(tty.screen).toContain('Cancelled — nothing was changed');
    expect(h.kills).toEqual([]);

    type('kill 300\r');
    type('\r');
    expect(h.kills).toEqual([]);
    type('kill 300\r');
    type('\u001b');
    expect(h.kills).toEqual([]);

    type('kill 300\r');
    type('y');
    expect(h.kills).toEqual([{ pid: 300, signal: 'SIGTERM' }]);
    expect(tty.screen).toContain('Sent SIGTERM to PID 300');

    type('revert app\t\r');
    expect(tty.screen).toContain('? Roll src/app.ts back to the version before its latest changes?');
    type('Y');
    expect(read(h.dir, 'src/app.ts')).toBe('app\n');
    ui.stop();
  });

  it('shows help and the process list until the next key, without acting on that key', async () => {
    const { tty, ui, type, onExit } = await startUi();
    type('help\r');
    expect(tty.screen).toContain('COMMANDS');
    type('q');
    expect(tty.screen).not.toContain('COMMANDS');
    expect(tty.screen).not.toContain('› q');
    expect(onExit).not.toHaveBeenCalled();

    type('status\r');
    expect(tty.screen).toContain('ALL PROCESSES');
    type('\u001b[B');
    expect(tty.screen).toContain('ACTIVITY');
    ui.stop();
  });

  it('redraws when the session changes and when the window is resized', async () => {
    vi.useFakeTimers();
    const { tty, ui, h } = await startUi();
    writeFiles(h.dir, { 'README.md': 'changed\n' });
    h.watcher.handleFileSystemEvent('change', 'README.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(tty.screen).toContain('CHANGE: README.md');
    expect(tty.screen).toContain('3 modified');

    tty.columns = 62;
    tty.rows = 14;
    tty.emit('resize');
    for (const line of tty.screen.split('\r\n')) {
      expect(Array.from(line).length).toBeLessThanOrEqual(62);
    }
    ui.stop();
  });
});

describe('plain output', () => {
  function startPlain(h: Harness, options: { quiet?: boolean; withInput?: boolean } = {}) {
    const lines: string[] = [];
    const input = new PassThrough();
    const onExit = vi.fn();
    const reporter = new PlainReporter({
      session: h.session,
      write: (line) => lines.push(line),
      input: options.withInput === false ? undefined : input,
      quiet: options.quiet,
      onExit,
    });
    reporter.start();
    const send = async (text: string) => {
      input.write(text);
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { lines, input, onExit, reporter, send };
  }

  it('prints one line per event, including ordinary file edits', () => {
    const h = createHarness({ files: { 'a.ts': 'a\n', '.env': 'S=1\n' } });
    const { lines, reporter } = startPlain(h);
    h.watcher.createCheckpoint();
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    h.watcher.handleFileSystemEvent('change', '.env');

    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d {2}INFO {2}file-edit {10}CHANGE: a\.ts \(1\/5 edits\/min\)$/);
    expect(lines[2]).toMatch(/WARN {2}protected-file/);
    reporter.stop();
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    expect(lines).toHaveLength(3);
  });

  it('keeps quiet about routine edits when asked to', () => {
    const h = createHarness({ files: { 'a.ts': 'a\n', '.env': 'S=1\n' } });
    const { lines } = startPlain(h, { quiet: true });
    h.watcher.createCheckpoint();
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    h.watcher.handleFileSystemEvent('change', '.env');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('protected-file');
  });

  it('accepts commands line by line and stops on exit', async () => {
    const h = await busyHarness();
    const { lines, onExit, send } = startPlain(h);

    await send('status\n');
    expect(lines.join('\n')).toMatch(/300\s+STALE\s+ELSEWHERE/);
    await send('help\n');
    expect(lines.join('\n')).toContain('revert <file>');
    await send('nonsense\n');
    expect(lines.at(-1)).toContain('Unknown command');

    expect(onExit).not.toHaveBeenCalled();
    await send('exit\n');
    expect(onExit).toHaveBeenCalledWith('command');
  });

  it('needs a typed "yes" for destructive commands', async () => {
    const h = await busyHarness();
    const { lines, send } = startPlain(h);

    await send('kill 300\n');
    expect(lines.at(-1)).toContain('Type "yes" to confirm');
    await send('maybe\n');
    expect(lines.at(-1)).toContain('Cancelled');
    expect(h.kills).toEqual([]);

    // the next line is a new command, not a late answer
    await send('yes\n');
    expect(h.kills).toEqual([]);

    await send('kill 300\nyes\n');
    expect(h.kills).toEqual([{ pid: 300, signal: 'SIGTERM' }]);
  });

  it('keeps running when its input ends', async () => {
    const h = createHarness({ files: { 'a.ts': 'a\n' } });
    const { lines, input, onExit } = startPlain(h);
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    h.watcher.createCheckpoint();
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    expect(onExit).not.toHaveBeenCalled();
    expect(lines.length).toBe(2);
  });
});
