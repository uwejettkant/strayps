import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeInput, parseCommand, runCommand } from '../src/ui/commands.js';
import {
  createPalette,
  formatEventLine,
  formatProcessTable,
  sanitize,
  shouldUseColor,
  truncate,
  truncateStart,
} from '../src/ui/format.js';
import { PlainReporter } from '../src/ui/plain.js';
import { type FrameView, renderFrame, TerminalUI } from '../src/ui/terminal.js';
import { cleanupTmpDirs, createHarness, type Harness, stripAnsi } from './helpers/harness.js';

afterEach(() => {
  cleanupTmpDirs();
  vi.useRealTimers();
});

const OTHER = '/work/other-repo';

/** One agent in the repo and one stale session elsewhere. */
async function busyHarness(): Promise<Harness> {
  const h = createHarness({
    procs: [
      { pid: 100, name: 'claude', cmd: 'claude --model claude-sonnet-5-5', cpu: 4, rssKb: 220_000, etime: '12:31' },
      { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 128_000, etime: '11-19:42:10', cpuTimeSec: 1.5 },
    ],
  });
  h.procs[0].cwd = h.dir;
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
    expect(parseCommand('kill 4711')).toEqual({ kind: 'kill', pid: 4711 });
    expect(parseCommand('k 12')).toEqual({ kind: 'kill', pid: 12 });
    expect(parseCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseCommand('panic')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('replaced by pause') });
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

  it('says where a file rollback went instead of rolling anything back', () => {
    for (const line of ['revert src/app.ts', 'rollback a b.ts', 'undo', 'revert']) {
      expect(parseCommand(line), line).toEqual({
        kind: 'invalid',
        message: 'Files are not watched any more: use git, or the checkpoints of your agent (Claude Code: /rewind).',
      });
    }
  });
});

describe('running commands against a session', () => {
  it('asks before every destructive command and does nothing until the answer is yes', async () => {
    const h = await busyHarness();

    const kill = runCommand(h.session, parseCommand('kill 300'));
    expect(kill.confirm?.prompt).toContain('PID 300');
    expect(kill.confirm?.prompt).toContain('Its agent session ends.');
    expect(kill.confirm?.prompt).not.toMatch(/stale|safe/i);
    const pause = runCommand(h.session, parseCommand('pause'));
    expect(pause.confirm?.prompt).toBe(
      "Pause 1 process of this repo's agents (claude 100)? Nothing is lost; resume continues them.",
    );

    // nothing happened yet
    expect(h.kills).toEqual([]);

    expect(kill.confirm!.run().message).toBe('Sent SIGTERM to PID 300');
    expect(h.kills).toEqual([{ pid: 300, signal: 'SIGTERM' }]);

    expect(pause.confirm!.run().message).toBe('Paused 1 process; type resume to continue');
    expect(h.kills.at(-1)).toEqual({ pid: 100, signal: 'SIGSTOP' });
    expect(formatProcessTable(h.session.getSnapshot().processes, createPalette(false, false)).join('\n')).toMatch(/100\s+PAUSED\s+THIS REPO/);
    // continuing is not destructive: no confirmation
    const resumed = runCommand(h.session, parseCommand('resume'));
    expect(resumed.message).toBe('Resumed 1 process');
    expect(resumed.confirm).toBeUndefined();
    expect(h.kills.at(-1)).toEqual({ pid: 100, signal: 'SIGCONT' });
  });

  it('ends an agent session with the processes it started after one confirmation that names them', async () => {
    const h = createHarness({
      procs: [
        { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 128_000, etime: '11-19:42:10', cpuTimeSec: 1.5 },
        { pid: 301, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', rssKb: 40_000, etime: '11-19:42:00' },
        { pid: 302, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-fetch', rssKb: 30_000, etime: '11-19:42:00' },
        { pid: 303, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-\u001b[2Jserver-evil', rssKb: 10_000, etime: '11-19:42:00' },
        { pid: 304, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-time', rssKb: 10_000, etime: '11-19:42:00' },
        // the most consequential member, an agent it started, is never folded away
        { pid: 305, ppid: 300, name: 'codex', cmd: 'codex exec', cwd: OTHER, rssKb: 90_000, etime: '01:00:00' },
      ],
    });
    await h.monitor.scan();

    const kill = runCommand(h.session, parseCommand('kill 300'));
    expect(kill.confirm?.prompt).toBe('End PID 300 and the 5 processes it started (301 MB)?');
    const details = kill.confirm?.details ?? [];
    expect(details).toHaveLength(6);
    expect(details[0]).toBe('PID 300  agent  claude  /work/other-repo  125 MB');
    expect(details[1]).toBe('PID 305  agent  codex  /work/other-repo  88 MB');
    for (const pid of [301, 302, 303, 304]) expect(details.join('\n')).toContain(`PID ${pid}  mcp`);
    expect(details.join('\n')).not.toContain('\u001b');
    expect(h.kills).toEqual([]);

    // the full-screen view shows every line in full and keeps the question with [y/N] visible
    const frame = renderFrame({
      snapshot: h.session.getSnapshot(),
      cols: 80,
      rows: 24,
      version: '9.9.9',
      dashboardUrl: null,
      demo: false,
      input: '',
      notice: null,
      confirmPrompt: kill.confirm!.prompt,
      confirmDetails: details,
      overlay: null,
      palette: createPalette(false),
      now: Date.now(),
    });
    const screen = frame.lines.join('\n');
    for (const line of details) expect(screen).toContain(line);
    expect(frame.lines.at(-2)).toContain('[y/N]');

    // a server the agent starts while the question is open is not part of what was confirmed
    h.procs.push({ pid: 306, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-later', etime: '00:01' });
    await h.monitor.scan();
    expect(kill.confirm!.run()).toEqual({
      level: 'warn',
      message: 'Sent SIGTERM to PID 300 and the 5 processes it started; PID 306 was not in the confirmation and keeps running',
    });
    expect(h.kills.map((k) => k.pid).sort()).toEqual([300, 301, 302, 303, 304, 305]);
  });

  it('refuses targets that are not on the lists', async () => {
    const h = await busyHarness();
    for (const line of ['kill 4242', 'kill 1', 'revert ../../etc/passwd']) {
      const result = runCommand(h.session, parseCommand(line));
      expect(result.level, line).toBe('error');
      expect(result.confirm, line).toBeUndefined();
    }
    expect(h.kills).toEqual([]);
  });

  it('says so when there is no agent to pause or nothing to resume', async () => {
    const h = createHarness();
    const pause = runCommand(h.session, parseCommand('pause'));
    expect(pause.message).toBe('No agent of this repo is running, nothing to pause');
    expect(pause.confirm).toBeUndefined();
    expect(runCommand(h.session, parseCommand('resume')).message).toBe('Nothing is paused');
    expect(runCommand(h.session, parseCommand('exit'))).toMatchObject({ exit: true });
    expect(runCommand(h.session, parseCommand('help'))).toMatchObject({ showHelp: true });
  });

  it('completes commands and PIDs, and nothing for commands that are gone', async () => {
    const h = await busyHarness();
    expect(completeInput(h.session, 'pa').input).toBe('pause ');
    expect(completeInput(h.session, 'kill 30').input).toBe('kill 300');
    expect(completeInput(h.session, 'kill ').candidates.sort()).toEqual(['100', '300']);
    expect(completeInput(h.session, 'rev')).toEqual({ input: 'rev', candidates: [] });
    expect(completeInput(h.session, 'revert src')).toEqual({ input: 'revert src', candidates: [] });
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
      { id: '1', type: 'process-alert', severity: 'warn', timestamp: new Date(2026, 10, 16, 9, 5, 7).getTime(), message: 'PID 7 evil\nname\u001b[31m' },
      createPalette(false),
    );
    expect(line).toBe('09:05:07  WARN  process-alert      PID 7 evil?name?[31m');
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

  it('shows what the dashboard shows: agents, MCP servers, what is left behind, events and processes', async () => {
    const h = await busyHarness();
    h.session.addEvent({ type: 'monitor-started', message: 'first entry', severity: 'info' });
    h.session.addEvent({ type: 'process-alert', message: 'second entry', severity: 'warn' });
    const frame = renderFrame(viewFor(h));
    const screen = frame.lines.join('\n');

    expect(frame.lines).toHaveLength(34);
    expect(screen).toContain('strayps v9.9.9');
    expect(screen).not.toMatch(/\bmode\b|balanced|modified|uncommitted|breaker|checkpoint/i);
    expect(screen).toContain('dashboard http://localhost:4321');
    expect(screen).toMatch(/AGENTS\s+2 sessions\s+340 MB/);
    expect(screen).toMatch(/MCP\s+0 servers/);
    expect(screen).toContain('LEFT BEHIND 1 stale/frozen · 125 MB');
    expect(screen).toContain('nothing held');
    expect(screen).toMatch(/300\s+STALE\s+ELSEWHERE\s+125\.0 MB\s+11d 19h/);
    expect(screen).toMatch(/100\s+ACTIVE\s+THIS REPO/);
    expect(screen).not.toMatch(/safe to kill|reclaimable/i);
    expect(screen).toContain('10:31:02');
    // oldest event first, like a log
    expect(screen.indexOf('first entry')).toBeLessThan(screen.indexOf('second entry'));
  });

  it('marks memory that is only RSS with a tilde, in rows and in every sum it is part of', async () => {
    const h = createHarness({
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', rssKb: 102_400, etime: '10:00' },
        // no footprint for it (the harness reads none without rssKb): RSS from the %MEM column
        { pid: 101, ppid: 100, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', memory: 1, etime: '10:00' },
      ],
    });
    h.procs[0].cwd = h.dir;
    await h.monitor.scan();
    const screen = renderFrame(viewFor(h)).lines.join('\n');
    expect(screen).toMatch(/100\s+\w+\s+THIS REPO\s+100\.0 MB/);
    expect(screen).toMatch(/101\s+\w+\s+THIS REPO\s+~16\.0 MB/);
    expect(screen).toMatch(/AGENTS\s+1 session\s+100 MB/);
    expect(screen).toMatch(/MCP\s+1 server\s+~16 MB/);
    expect(screen).toContain('2 monitored · ~116 MB');
    expect(renderFrame(viewFor(h, { overlay: 'help' })).lines.join('\n')).toContain('~ marks RSS');
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

  it('cannot be hijacked by command lines, directories or log messages', async () => {
    const h = createHarness({
      procs: [{ pid: 7, name: 'node', cmd: 'node mcp-server \u001b[2J\u001b[31mHACKED\u0007', cwd: '/tmp/\u001b]0;title\u0007', etime: '10:00' }],
    });
    await h.monitor.scan();
    h.session.addEvent({ type: 'process-alert', message: 'evil\u001b[2J\u001b[1;1H\rname', severity: 'warn' });

    const frame = renderFrame(viewFor(h));
    for (const line of frame.lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(frame.lines.join('\n')).toContain('evil?[2J?[1;1H?name');
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
    expect(help).toContain('kill <pid>');
    expect(help).not.toContain('revert');
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
    expect(tty.screen).toContain('strayps v9.9.9');

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

  it('does not take yes for a session whose processes do not all fit on the screen', async () => {
    const procs = [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '01:00:00' }];
    for (let i = 1; i <= 30; i++) {
      procs.push({ pid: 300 + i, ppid: 300, name: 'node', cmd: `node /x/node_modules/.bin/mcp-server-${i}`, etime: '01:00:00' } as never);
    }
    const h = createHarness({ procs });
    await h.monitor.scan();
    const { tty, ui, type } = await startUi(h);
    type('kill 300\r');
    expect(tty.screen).toContain('ENDS WHEN YOU ANSWER y');
    expect(tty.screen).toContain('more do not fit');
    type('y');
    expect(h.kills).toEqual([]);
    expect(tty.screen).toContain('Nothing was ended');

    // with room for every line, the same answer ends the session
    tty.rows = 50;
    type('kill 300\r');
    type('y');
    expect(h.kills.map((k) => k.pid)).toHaveLength(31);
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

    type('pause\r');
    type('Y');
    expect(h.kills.at(-1)).toEqual({ pid: 100, signal: 'SIGSTOP' });
    type('resume\r');
    expect(h.kills.at(-1)).toEqual({ pid: 100, signal: 'SIGCONT' });
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
    h.session.addEvent({ type: 'process-alert', message: 'PID 300 looks left behind', severity: 'warn' });
    await vi.advanceTimersByTimeAsync(60);
    expect(tty.screen).toContain('PID 300 looks left behind');

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

  it('prints one line per event', () => {
    const h = createHarness();
    const { lines, reporter } = startPlain(h);
    h.session.addEvent({ type: 'monitor-started', message: 'Watching', severity: 'info' });
    h.session.addEvent({ type: 'process-alert', message: 'PID 7 is frozen', severity: 'warn' });

    expect(lines.slice(-2)[0]).toMatch(/^\d\d:\d\d:\d\d {2}INFO {2}monitor-started {4}Watching$/);
    expect(lines.slice(-2)[1]).toMatch(/WARN {2}process-alert {6}PID 7 is frozen$/);
    const count = lines.length;
    reporter.stop();
    h.session.addEvent({ type: 'process-alert', message: 'after stop', severity: 'warn' });
    expect(lines).toHaveLength(count);
  });

  it('prints only warnings and critical events when asked to keep quiet', () => {
    const h = createHarness();
    const { lines } = startPlain(h, { quiet: true });
    const before = lines.length;
    h.session.addEvent({ type: 'monitor-started', message: 'Watching', severity: 'info' });
    h.session.addEvent({ type: 'process-alert', message: 'PID 7 is frozen', severity: 'warn' });
    expect(lines.slice(before)).toHaveLength(1);
    expect(lines.at(-1)).toContain('process-alert');
  });

  it('names every process of an agent session before it asks', async () => {
    const h = createHarness({
      procs: [
        { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 128_000, etime: '01:00:00' },
        { pid: 301, ppid: 300, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', rssKb: 40_000, etime: '01:00:00' },
      ],
    });
    await h.monitor.scan();
    const { lines, send } = startPlain(h, { quiet: true });
    await send('kill 300\n');
    const asked = lines.findIndex((line) => line.includes('End PID 300 and the 1 process it started'));
    expect(lines.slice(asked - 2, asked)).toEqual(['  PID 300  agent  claude  /work/other-repo  125 MB', '  PID 301  mcp  mcp-server-git  39 MB']);
    expect(h.kills).toEqual([]);
  });

  it('accepts commands line by line and stops on exit', async () => {
    const h = await busyHarness();
    const { lines, onExit, send } = startPlain(h);

    await send('status\n');
    expect(lines.join('\n')).toMatch(/300\s+STALE\s+ELSEWHERE/);
    await send('help\n');
    expect(lines.join('\n')).toContain('kill <pid>');
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
    expect(lines.at(-1)).toContain('Type "yes"');
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
    const h = createHarness();
    const { lines, input, onExit } = startPlain(h);
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    const before = lines.length;
    h.session.addEvent({ type: 'process-alert', message: 'still here', severity: 'warn' });
    expect(onExit).not.toHaveBeenCalled();
    expect(lines.length).toBe(before + 1);
  });
});
