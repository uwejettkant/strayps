import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMonitor, STALE_QUIET_SEC } from '../src/core/process-monitor.js';
import type { RawProcessInfo } from '../src/core/processes/types.js';
import { agent, mcp, OTHER, REPO, setup } from './helpers/processes.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ProcessMonitor classification (production rules)', () => {
  it('treats an idle MCP server with a living parent as STANDBY, however long it waits', async () => {
    const { monitor } = setup([agent(100, REPO, { cpu: 3 }), mcp(101, 100, { etime: '09:12:00' })]);

    const t0 = 1_000_000;
    await monitor.scan(t0);
    const later = await monitor.scan(t0 + 10 * 60_000);

    const child = later.find((p) => p.pid === 101)!;
    expect(child.status).toBe('STANDBY');
    expect(child.agentPid).toBe(100);
    expect(monitor.getFrozenProcesses()).toHaveLength(0);
  });

  it('keeps tool processes of the watched session out of STALE, whatever their own working directory is', async () => {
    // Second half of the "22,042 seconds" incident: the session's MCP server was flagged too.
    // MCP servers often run in "/" (unresolvable) or in their own install directory.
    const { monitor } = setup([
      agent(100, REPO, { cpu: 3, etime: '06:07:22' }),
      mcp(101, 100, { etime: '06:07:20' }),
      mcp(102, 100, { etime: '06:07:20', cwd: '/opt/tools/some-mcp' }),
    ]);

    const list = await monitor.scan(1_000);
    for (const pid of [101, 102]) {
      const child = list.find((p) => p.pid === pid)!;
      expect(child.status).toBe('STANDBY');
      expect(child.inWatchedRepo).toBe(true);
    }
    expect(monitor.getFrozenProcesses()).toHaveLength(0);
  });

  it('never marks the agent session of the watched repo as stale or frozen, across scans and beyond 6 hours', async () => {
    // Regression for the "22,042 seconds" incident: an idle moment after six hours of work
    const { monitor } = setup([agent(62536, REPO, { ppid: 62163, etime: '06:07:22', cpu: 0 })]);
    const onFrozen = vi.fn();
    monitor.on('process-frozen', onFrozen);

    const t0 = 2_000_000;
    await monitor.scan(t0);
    await monitor.scan(t0 + 46_000);
    const list = await monitor.scan(t0 + 30 * 60_000);

    expect(list[0].status).toBe('IDLE');
    expect(list[0].inWatchedRepo).toBe(true);
    expect(list[0].pauseTarget).toBe(true);
    expect(onFrozen).not.toHaveBeenCalled();
  });

  it('flags an old session in another repository as STALE once it has used no CPU time for the quiet window', async () => {
    const { monitor, procs, alive } = setup([
      { pid: 500, ppid: 1, name: 'Code', cmd: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
      { pid: 501, ppid: 500, name: 'Code Helper (Plugin)', cmd: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
      // ps %cpu still shows a decaying average; the CPU time does not move
      agent(502, OTHER, { ppid: 501, etime: '02-15:40:05', cpu: 0.3, cpuTimeSec: 812.4 }),
      mcp(503, 502, { cwd: OTHER, etime: '02-15:40:01', cpuTimeSec: 3.1 }),
    ]);
    const t0 = Date.now();
    const at = async (offsetSec: number) => (await monitor.scan(t0 + offsetSec * 1000)).find((p) => p.pid === 502)!;

    // strayps has only just started watching: no evidence of inactivity yet
    expect((await at(0)).status).not.toBe('STALE');
    expect((await at(STALE_QUIET_SEC - 1)).status).not.toBe('STALE');

    // idle is not zero: timers and housekeeping use a little CPU time
    procs.find((p) => p.pid === 502)!.cpuTimeSec = 812.45;
    const session = await at(STALE_QUIET_SEC);
    expect(session.status).toBe('STALE');
    expect(session.host).toBe('VS Code');
    expect(session.reason).toBe(
      'Session in /work/other-repo, running for 2d 15h, idle: no new process and 0.05 s CPU time in the last 10m, attached to VS Code',
    );
    // an observation, not a verdict: age alone has been wrong about sessions still in use
    expect(session.reason).not.toMatch(/safe to kill/i);
    expect(session.inWatchedRepo).toBe(false);
    expect(session.pauseTarget).toBe(false);
    // the editor itself is not an agent process
    expect((await monitor.scan(t0 + STALE_QUIET_SEC * 1000)).map((p) => p.pid).sort()).toEqual([502, 503]);

    // as soon as it works again, it is no longer stale: a tool call starts a process
    procs.push({ pid: 504, ppid: 502, name: 'git', cmd: 'git status' });
    alive.add(504);
    const working = await at(STALE_QUIET_SEC + 2);
    expect(working.status).not.toBe('STALE');
    expect(working.reason).toContain('in use: started a process 0s ago');
    // and it stays in use for the whole window after that, even when the process is gone again
    procs.splice(procs.findIndex((p) => p.pid === 504), 1);
    expect((await at(STALE_QUIET_SEC * 2)).status).not.toBe('STALE');
    expect((await at(STALE_QUIET_SEC * 2 + 4)).status).toBe('STALE');
  });

  it('calls a resting agent stale although it ticks: idle agents used up to 6.5 s of CPU time per 10 minutes', async () => {
    // Measured on 20.11.2026: idle agy 0.8 to 1.0 s, idle claude in a terminal 1.4 to 5.5 s, idle
    // claude in Claude Desktop 4.6 to 6.5 s per 10 minutes; none of them started a process
    const { monitor, procs } = setup([agent(502, OTHER, { etime: '02-15:40:05', cpuTimeSec: 100 }), mcp(503, 502, { cwd: OTHER, cpuTimeSec: 0.4 })]);
    const t0 = Date.now();
    for (let minute = 0; minute <= 10; minute++) {
      procs[0].cpuTimeSec = 100 + minute * 0.65;
      await monitor.scan(t0 + minute * 60_000);
    }
    const session = (await monitor.scan(t0 + 10 * 60_000)).find((p) => p.pid === 502)!;
    expect(session.status).toBe('STALE');
    expect(session.reason).toContain('idle: no new process and 6.50 s CPU time in the last 10m');
  });

  it('never calls a session stale while it starts processes, however little CPU time it uses', async () => {
    // a working agent runs tools (a shell, git, rg, tests); a resting one starts nothing
    const { monitor, procs, alive } = setup([agent(502, OTHER, { etime: '02-15:40:05', cpuTimeSec: 100 })]);
    const t0 = Date.now();
    for (let minute = 0; minute <= 60; minute++) {
      if (minute % 8 === 0) {
        procs.push({ pid: 9000 + minute, ppid: 502, name: 'zsh', cmd: '/bin/zsh -c git diff' });
        alive.add(9000 + minute);
      }
      const [session] = (await monitor.scan(t0 + minute * 60_000)).filter((p) => p.pid === 502);
      expect(session.status, `minute ${minute}`).not.toBe('STALE');
    }
  });

  it('does not count the processes strayps starts itself as work of the agent that started it', async () => {
    // strayps runs ps every 2 s; started from an agent's shell, that agent looked busy forever
    const { monitor, procs, alive } = setup(
      [
        agent(502, OTHER, { etime: '02-15:40:05', cpuTimeSec: 100 }),
        { pid: 600, ppid: 502, name: 'node', cmd: 'node strayps watch' },
      ],
      { selfPid: 600 },
    );
    const t0 = Date.now();
    for (let minute = 0; minute <= 10; minute++) {
      procs.push({ pid: 7000 + minute, ppid: 600, name: 'ps', cmd: 'ps -Ao pid,comm' });
      alive.add(7000 + minute);
      await monitor.scan(t0 + minute * 60_000);
    }
    const session = (await monitor.scan(t0 + 10 * 60_000)).find((p) => p.pid === 502)!;
    expect(session.status).toBe('STALE');
  });

  it('never calls an old session in another repository stale while it keeps using CPU time', async () => {
    // a two-day-old session at an open editor window was called stale by age alone
    const { monitor, procs } = setup([agent(502, OTHER, { etime: '02-15:40:05', cpuTimeSec: 100 })]);
    const t0 = Date.now();
    for (let minute = 0; minute <= 60; minute += 5) {
      // working without starting a process (a long answer): 1 s of CPU time per minute
      procs[0].cpuTimeSec = 100 + minute * 1.0;
      const [session] = await monitor.scan(t0 + minute * 60_000);
      expect(session.status, `minute ${minute}`).not.toBe('STALE');
    }
  });

  it('says where a young session in another repository works instead of calling it the current one', async () => {
    const { monitor } = setup([agent(502, OTHER, { etime: '30:00', cpuTimeSec: 1 })]);
    const [session] = await monitor.scan(Date.now());
    expect(session.reason).toBe('Session in /work/other-repo (open for 30m 0s)');
  });

  it('never calls a session stale when its CPU time cannot be read', async () => {
    const { monitor } = setup([agent(502, OTHER, { etime: '13-00:00:00', cpu: 0 })]);
    const t0 = Date.now();
    for (const offset of [0, STALE_QUIET_SEC, 24 * 3600]) {
      const [session] = await monitor.scan(t0 + offset * 1000);
      expect(session.status).not.toBe('STALE');
    }
    const [session] = await monitor.scan(t0 + 1000);
    expect(session.reason).toContain('its CPU time cannot be read, so it is never called stale');
  });

  it('does not call a quiet process frozen while its parent is alive, however long it is quiet', async () => {
    // a resting watch server, a browser and a young session in another repository
    // were "frozen" after 45 quiet seconds. Quiet is not frozen.
    const { monitor } = setup([
      { pid: 50, name: 'zsh', cmd: '-zsh', cwd: REPO, cpu: 0, etime: '02:00:00' },
      agent(52, REPO, { ppid: 50, etime: '40:00' }),
      { pid: 51, ppid: 52, name: 'node', cmd: 'node node_modules/.bin/tsx watch src/server.ts', cwd: REPO, cpu: 0, etime: '30:00' },
      { pid: 60, name: 'zsh', cmd: '-zsh', cwd: OTHER, cpu: 0, etime: '02:00:00' },
      agent(62, OTHER, { ppid: 60, etime: '15:00' }),
      { pid: 61, ppid: 62, name: 'Chromium', cmd: 'Chromium --headless --remote-debugging-port=9222', cpu: 0, etime: '14:00' },
    ]);
    const t0 = Date.now();
    for (const t of [t0, t0 + 46_000, t0 + 3_600_000]) {
      const list = await monitor.scan(t);
      for (const pid of [51, 61, 62]) {
        const proc = list.find((p) => p.pid === pid);
        expect(proc, `PID ${pid} at +${(t - t0) / 1000}s`).toBeDefined();
        expect(proc?.status, `PID ${pid} at +${(t - t0) / 1000}s`).not.toBe('FROZEN');
      }
    }
    expect(monitor.getFrozenProcesses()).toEqual([]);
  });

  it('calls a quiet process frozen only when its parent is gone', async () => {
    // Its process group (that of the agent that started it) has no leader any more
    const { monitor } = setup([mcp(70, 1, { pgid: 69, etime: '01:00:00' })]);
    const t0 = Date.now();
    await monitor.scan(t0);
    const [orphan] = await monitor.scan(t0 + 46_000);
    expect(orphan.status).toBe('FROZEN');
    expect(orphan.reason).toContain('its parent is gone');
  });

  it('does not take an app started from the Dock or Finder for an orphan', async () => {
    // On macOS launchd (PID 1) is the parent of every app it starts, and makes each one the
    // leader of its own process group. A process whose parent died keeps its old group.
    const t0 = Date.now();
    const { monitor } = setup([
      { pid: 80, ppid: 1, pgid: 80, name: 'mcp-inspector', cmd: '/Applications/MCP Inspector.app/Contents/MacOS/mcp-inspector', cpu: 0, etime: '05:00:00' },
      // without a process group (fallback lister) there is no evidence that the parent is gone
      mcp(81, 1, { etime: '05:00:00' }),
    ]);
    for (const t of [t0, t0 + 46_000, t0 + 3_600_000]) {
      const list = await monitor.scan(t);
      expect(list.map((p) => [p.pid, p.status]).sort()).toEqual([
        [80, 'IDLE'],
        [81, 'IDLE'],
      ]);
    }
  });

  it('keeps an idle MCP server of a running app in STANDBY, however old it is', async () => {
    // Measured on 20.11.2026: an MCP server of the open Antigravity app, without a working
    // directory, 10 h old and 0.00 s CPU time in 10 min, was called STALE. It waits for tool calls.
    const t0 = Date.now();
    const { monitor } = setup([
      { pid: 90, ppid: 1, pgid: 90, name: 'Electron', cmd: '/Applications/Antigravity.app/Contents/MacOS/Electron', cpu: 0, etime: '10:07:00' },
      { pid: 91, ppid: 90, pgid: 90, name: 'Antigravity Helper', cmd: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper', cpu: 0, etime: '10:07:00' },
      mcp(92, 91, { pgid: 90, etime: '10:07:00', cpuTimeSec: 0.4 }),
    ]);
    for (const offset of [0, 46, STALE_QUIET_SEC, STALE_QUIET_SEC + 3600]) {
      const server = (await monitor.scan(t0 + offset * 1000)).find((p) => p.pid === 92)!;
      expect(server.status, `after ${offset} s`).toBe('STANDBY');
      expect(server.host).toBe('Antigravity');
    }
  });

  it('still calls an old idle MCP server stale when no app holds it', async () => {
    const t0 = Date.now();
    const { monitor } = setup([
      // detached: started by launchd, leader of its own group, nobody waiting for its answers
      mcp(93, 1, { pgid: 93, etime: '10:07:00', cpuTimeSec: 0.4 }),
      // held by a terminal, not by an app: the terminal says nothing about whether it is in use
      { pid: 94, ppid: 1, pgid: 94, name: 'tmux', cmd: 'tmux new -s work', cpu: 0, etime: '2-00:00:00' },
      { pid: 95, ppid: 94, pgid: 95, name: 'zsh', cmd: '-zsh', cpu: 0, etime: '2-00:00:00' },
      mcp(96, 95, { pgid: 96, etime: '10:07:00', cpuTimeSec: 0.4 }),
    ]);
    await monitor.scan(t0);
    const list = await monitor.scan(t0 + STALE_QUIET_SEC * 1000);
    expect(list.filter((p) => p.pid === 93 || p.pid === 96).map((p) => [p.pid, p.status])).toEqual([
      [93, 'STALE'],
      [96, 'STALE'],
    ]);
    expect(list.find((p) => p.pid === 93)!.reason).toContain('MCP process without a working directory');
  });

  it('marks tool processes started by an agent of the watched repo as belonging to it', async () => {
    const { monitor } = setup([
      agent(100, REPO, { cpu: 2 }),
      { pid: 110, ppid: 100, name: 'npm', cmd: 'npm exec some-mcp-server' },
      mcp(111, 110, { cwd: '/' }),
      agent(200, OTHER, { cpu: 2 }),
      mcp(201, 200, { cwd: OTHER }),
    ]);

    const list = await monitor.scan(1_000);
    const byPid = new Map(list.map((p) => [p.pid, p]));
    expect(byPid.get(100)?.inWatchedRepo).toBe(true);
    expect(byPid.get(111)?.inWatchedRepo).toBe(true);
    expect(byPid.get(200)?.inWatchedRepo).toBe(false);
    expect(byPid.get(201)?.inWatchedRepo).toBe(false);
    // the npm wrapper with a running child is not listed separately
    expect(byPid.has(110)).toBe(false);
  });

  it('does not list the wrappers that launched strayps itself', async () => {
    const { monitor } = setup(
      [
        { pid: 10, ppid: 1, name: 'zsh', cmd: '-zsh' },
        agent(15, REPO, { ppid: 10, cpu: 1 }),
        { pid: 20, ppid: 15, name: 'node', cmd: `node ${REPO}/node_modules/.bin/tsx src/cli.ts watch`, etime: '05:00' },
        { pid: 30, ppid: 20, name: 'node', cmd: 'node src/cli.ts watch', etime: '05:00' },
        { pid: 40, ppid: 15, name: 'node', cmd: 'node ./node_modules/.bin/tsx watch server.ts', cwd: REPO, etime: '05:00' },
      ],
      { selfPid: 30 },
    );

    const list = await monitor.scan(1_000);
    expect(list.map((p) => [p.pid, p.category])).toEqual([[15, 'agent'], [40, 'child']]);
  });

  it('keeps the previous list and reports when the process scan itself fails', async () => {
    let fail = false;
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => {
        if (fail) throw new Error('ps: command not found');
        return [agent(100, REPO, { cpu: 1 })];
      },
    });
    const onError = vi.fn();
    monitor.on('scan-error', onError);

    await monitor.scan(1_000);
    fail = true;
    const list = await monitor.scan(2_000);

    expect(list.map((p) => p.pid)).toEqual([100]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('runs one scan at a time when calls overlap', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => {
        calls += 1;
        await gate;
        return [agent(100, REPO)];
      },
    });

    const first = monitor.scan(1_000);
    const second = monitor.scan(1_001);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe('ProcessMonitor agent detection (no list of products to keep up to date)', () => {
  // A terminal tab as seen on macOS: the terminal app, a login shell in it
  const terminalTab: RawProcessInfo[] = [
    { pid: 70, ppid: 1, name: '/Applications/Warp.app/Contents/MacOS/stable', cmd: '/Applications/Warp.app/Contents/MacOS/stable' },
    { pid: 71, ppid: 70, name: '-zsh', cmd: '-zsh' },
  ];

  it('finds an agent it has never heard of by the MCP server it starts', async () => {
    // Shape observed on 17.11.2026 with the Antigravity CLI: agent -> npm exec wrapper -> MCP server
    const { monitor } = setup([
      ...terminalTab,
      { pid: 80, ppid: 71, name: 'tool-agent', cmd: '/Users/dev/.local/bin/tool-agent', cwd: REPO, cpu: 0, rssKb: 90_000, etime: '33:08' },
      { pid: 81, ppid: 80, name: 'npm', cmd: 'npm exec some-mcp-server@latest', cwd: REPO },
      mcp(82, 81, { cwd: REPO }),
    ]);

    const t0 = 3_000_000;
    await monitor.scan(t0);
    const list = await monitor.scan(t0 + 30 * 60_000);
    const agentProc = list.find((p) => p.pid === 80);
    expect(agentProc).toMatchObject({ category: 'agent', detectedBy: 'mcp-client', inWatchedRepo: true });
    expect(['ACTIVE', 'IDLE']).toContain(agentProc!.status);
    expect(list.find((p) => p.pid === 82)).toMatchObject({ category: 'mcp', inWatchedRepo: true, agentPid: 80 });
    // the terminal, the shell and the npm wrapper are not listed
    expect(list.map((p) => p.pid).sort((a, b) => a - b)).toEqual([80, 82]);
  });

  it('never takes an editor, a desktop app or a terminal that starts MCP servers for an agent', async () => {
    const { monitor } = setup([
      { pid: 500, ppid: 1, name: '/Applications/Visual Studio Code.app/Contents/MacOS/Code', cmd: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
      { pid: 501, ppid: 500, name: 'Code Helper (Plugin)', cmd: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', cwd: REPO },
      mcp(502, 501, { cwd: REPO }),
      { pid: 600, ppid: 1, name: '/Applications/Claude.app/Contents/MacOS/Claude', cmd: '/Applications/Claude.app/Contents/MacOS/Claude' },
      mcp(601, 600),
      ...terminalTab,
      mcp(73, 71, { cwd: REPO }),
    ]);

    const list = await monitor.scan(1_000);
    expect(list.filter((p) => p.category === 'agent')).toEqual([]);
    expect(list.map((p) => p.pid).sort((a, b) => a - b)).toEqual([73, 502, 601]);
    expect(list.find((p) => p.pid === 502)?.host).toBe('VS Code');
  });

  it('recognizes an agent an IDE started even when its arguments name the IDE, and the IDE stays a host', async () => {
    // Seen on 20.11.2026: agy started by the Antigravity IDE, with "antigravity" in its arguments,
    // was taken for the IDE itself. It was not listed, and pause would not have held it.
    const app = '/Applications/Antigravity IDE.app/Contents';
    const { monitor } = setup([
      { pid: 300, ppid: 1, pgid: 300, name: `${app}/MacOS/Electron`, cmd: `${app}/MacOS/Electron` },
      {
        pid: 301,
        ppid: 300,
        name: `${app}/Frameworks/Antigravity IDE Helper (Plugin).app/Contents/MacOS/Antigravity IDE Helper (Plugin)`,
        cmd: `${app}/Frameworks/Antigravity IDE Helper (Plugin).app/Contents/MacOS/Antigravity IDE Helper (Plugin) --type=utility`,
      },
      { pid: 302, ppid: 301, name: '/Users/dev/.gemini/bin/agy', cmd: '/Users/dev/.gemini/bin/agy --client antigravity --stdio', cwd: REPO, cpu: 1, etime: '05:00:00' },
      { pid: 303, ppid: 302, name: 'npm', cmd: 'npm exec x-mcp-server', cwd: REPO, etime: '05:00:00' },
      mcp(304, 303, { cwd: REPO }),
      // an MCP server the IDE starts itself: the IDE is its host, not an agent
      mcp(305, 301, { cwd: REPO }),
    ]);
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p]));
    expect(byPid.get(302)).toMatchObject({ category: 'agent', detectedBy: 'mcp-client', host: 'Antigravity', pauseTarget: true });
    expect(byPid.get(304)).toMatchObject({ category: 'mcp', agentPid: 302 });
    expect(byPid.get(305)?.agentPid).toBeUndefined();
    expect(byPid.get(305)?.host).toBe('Antigravity');
    expect(byPid.has(300) || byPid.has(301)).toBe(false);
  });

  it('never takes a program for a host because of a word in its arguments', async () => {
    // an agent named in the settings, run with arguments that name a terminal and an editor
    const { monitor } = setup([
      ...terminalTab,
      { pid: 90, ppid: 71, name: 'vibe', cmd: 'vibe --term xterm-256color --open-in windsurf', cwd: REPO, cpu: 1, etime: '05:00' },
      mcp(91, 90, { cwd: REPO }),
    ]);
    monitor.setAgentNames(['vibe']);
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p]));
    expect(byPid.get(91)).toMatchObject({ agentPid: 90, host: 'terminal' });
  });

  it('recognizes an agent by its MCP server even when its path names an IDE, while refusing real IDEs and their helpers', async () => {
    // HOST_PATTERNS matched words anywhere in a path, so an MCP client inside ~/WebstormProjects
    // or ~/PycharmProjects looked like the IDE and was missed (maintainer decision, 22.11.2026)
    const { monitor } = setup([
      ...terminalTab,
      { pid: 80, ppid: 71, name: '/usr/local/bin/node', cmd: 'node /Users/x/WebstormProjects/my-agent/cli.js', cwd: REPO, cpu: 1, etime: '10:00' },
      mcp(81, 80, { cwd: REPO }),
      {
        pid: 82,
        ppid: 71,
        name: '/Users/x/PycharmProjects/bot/.venv/bin/python',
        cmd: '/Users/x/PycharmProjects/bot/.venv/bin/python /Users/x/PycharmProjects/bot/bot.py',
        cwd: REPO,
        cpu: 1,
        etime: '10:00',
      },
      mcp(83, 82, { cwd: REPO }),
      // other direction: real IDE processes that start MCP servers must never become agents
      { pid: 90, ppid: 1, pgid: 90, name: '/Applications/Antigravity.app/Contents/MacOS/Antigravity', cmd: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
      {
        pid: 91,
        ppid: 90,
        pgid: 90,
        name: '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server',
        cmd: '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server --port 9000',
      },
      { pid: 92, ppid: 91, name: 'npm', cmd: 'npm exec x-mcp-server' },
      mcp(93, 92),
      { pid: 94, ppid: 1, pgid: 94, name: '/opt/jetbrains/bin/webstorm', cmd: '/opt/jetbrains/bin/webstorm' },
      mcp(95, 94, { cwd: REPO }),
      { pid: 96, ppid: 1, pgid: 96, name: '/home/dev/.vscode-server/bin/abc/node', cmd: '/home/dev/.vscode-server/bin/abc/node /home/dev/.vscode-server/bin/abc/out/server-main.js' },
      mcp(97, 96, { cwd: REPO }),
    ]);
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p]));
    expect(byPid.get(80)).toMatchObject({ category: 'agent', detectedBy: 'mcp-client', host: 'terminal', pauseTarget: true });
    expect(byPid.get(81)).toMatchObject({ category: 'mcp', agentPid: 80, host: 'terminal' });
    expect(byPid.get(82)).toMatchObject({ category: 'agent', detectedBy: 'mcp-client', host: 'terminal', pauseTarget: true });
    expect(byPid.get(83)).toMatchObject({ category: 'mcp', agentPid: 82, host: 'terminal' });
    for (const idePid of [90, 91, 94, 96]) {
      expect(byPid.has(idePid), `IDE PID ${idePid} must not become an agent`).toBe(false);
    }
    expect(byPid.get(93)?.agentPid).toBeUndefined();
    expect(byPid.get(93)?.host).toBe('Antigravity');
    expect(byPid.get(95)?.agentPid).toBeUndefined();
    expect(byPid.get(97)?.agentPid).toBeUndefined();
  });

  it('does not take the login program of a terminal tab for an agent', async () => {
    // Terminal.app and Ghostty start the shell through login; an MCP server run by hand in such a
    // tab made login an agent, and everything in the tab its session (review, 20.11.2026)
    const { monitor } = setup([
      { pid: 80, ppid: 1, pgid: 80, name: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', cmd: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
      { pid: 81, ppid: 80, name: 'login', cmd: 'login -pf dev', cwd: REPO },
      { pid: 82, ppid: 81, name: '-zsh', cmd: '-zsh', cwd: REPO },
      { pid: 83, ppid: 82, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-inspector', cwd: REPO, etime: '10:00' },
      { pid: 84, ppid: 82, name: 'vim', cmd: 'vim notes.md', cwd: REPO, etime: '30:00' },
    ]);
    const list = await monitor.scan(1_000);
    expect(list.filter((p) => p.category === 'agent')).toEqual([]);
    expect(list.map((p) => p.pid)).toEqual([83]);
    expect(list[0].host).toBe('terminal');
  });

  it('recognizes programs named in the agents setting, by their exact name', async () => {
    const { monitor } = setup([
      ...terminalTab,
      { pid: 90, ppid: 71, name: 'vibe', cmd: 'vibe', cwd: REPO, cpu: 1, etime: '05:00' },
      { pid: 91, ppid: 71, name: 'python3', cmd: 'python3 /home/dev/.local/bin/vibe --resume', cwd: REPO, cpu: 1, etime: '05:00' },
      { pid: 92, ppid: 71, name: 'node', cmd: `node ${REPO}/tools/vibe-check.js`, cwd: REPO, cpu: 1, etime: '05:00' },
    ]);

    expect((await monitor.scan(1_000)).filter((p) => p.category === 'agent')).toEqual([]);

    monitor.setAgentNames(['Vibe']);
    const list = await monitor.scan(2_000);
    const agents = list.filter((p) => p.category === 'agent');
    expect(agents.map((p) => p.pid).sort((a, b) => a - b)).toEqual([90, 91]);
    expect(agents.every((p) => p.detectedBy === 'setting')).toBe(true);
    // vibe-check.js only contains the name: no agent, and nothing an agent started
    expect(list.some((p) => p.pid === 92)).toBe(false);
  });

  it('does not take a program for an agent because its name merely contains one', async () => {
    const { monitor } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 101, ppid: 100, name: 'node', cmd: 'node /x/node_modules/.bin/codex-mcp-server', cwd: REPO },
      { pid: 102, ppid: 1, name: 'node', cmd: `node ${REPO}/scripts/aider-stats.js`, cwd: REPO },
    ]);

    const list = await monitor.scan(1_000);
    expect(list.find((p) => p.pid === 101)?.category).toBe('mcp');
    // not an agent, so not listed at all: nothing an agent started either
    expect(list.some((p) => p.pid === 102)).toBe(false);
  });

  it('still recognizes Claude Code, Codex and Aider by name, however they are started', async () => {
    const { monitor } = setup([
      agent(100, REPO),
      { pid: 110, ppid: 71, name: 'codex', cmd: '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex', cwd: REPO },
      { pid: 111, ppid: 71, name: 'node', cmd: 'node /usr/local/bin/codex --full-auto', cwd: REPO },
      { pid: 112, ppid: 71, name: 'python3.12', cmd: '/opt/homebrew/bin/python3.12 /Users/dev/.local/bin/aider --model x', cwd: REPO },
      { pid: 113, ppid: 71, name: 'python3', cmd: 'python3 -m aider', cwd: REPO },
      { pid: 114, ppid: 71, name: 'node', cmd: 'node /Users/dev/.vscode/extensions/anthropic.claude-code-2.1.0/cli.js', cwd: REPO },
      ...terminalTab,
    ]);

    const list = await monitor.scan(1_000);
    const agents = list.filter((p) => p.category === 'agent');
    expect(agents.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 110, 111, 112, 113, 114]);
    expect(agents.every((p) => p.detectedBy === 'name')).toBe(true);
  });
});

describe('ProcessMonitor: what an agent started', () => {
  // A "node", "chromium" or "playwright" anywhere in a command line was enough to be listed: the
  // user's own dev servers, test runners and browser apps showed up next to the agents (cut on
  // 20.11.2026). What is not an agent or an MCP server is listed only because an agent started it.
  const tree = (): RawProcessInfo[] => [
    agent(100, REPO, { cpu: 3 }),
    mcp(101, 100),
    // a dev server the agent started through a shell and npm
    { pid: 105, ppid: 100, name: 'zsh', cmd: '/bin/zsh -c npm run dev', cwd: REPO, etime: '08:00' },
    { pid: 106, ppid: 105, name: 'npm', cmd: 'npm run dev', cwd: REPO, etime: '08:00' },
    { pid: 110, ppid: 106, name: 'node', cmd: 'node node_modules/.bin/next dev', cwd: REPO, cpu: 2, rssKb: 90_000, etime: '07:59' },
    // a browser its MCP server opened
    { pid: 121, ppid: 101, name: 'Chromium', cmd: 'Chromium --headless --remote-debugging-port=9222', rssKb: 120_000, etime: '05:00' },
    // a tool call that just started
    { pid: 130, ppid: 100, name: 'git', cmd: 'git status', cwd: REPO, etime: '00:01' },
    // what the user started: a terminal with a watch server, a browser app, an orphaned test run
    { pid: 200, name: 'zsh', cmd: '-zsh', cwd: REPO, etime: '02:00:00' },
    { pid: 201, ppid: 200, name: 'node', cmd: 'node node_modules/.bin/tsx watch src/server.ts', cwd: REPO, etime: '30:00' },
    { pid: 300, ppid: 1, pgid: 300, name: 'Chromium', cmd: '/Applications/Chromium.app/Contents/MacOS/Chromium', etime: '03:00:00' },
    { pid: 301, ppid: 1, pgid: 299, name: 'node', cmd: 'node node_modules/.bin/playwright test', cwd: REPO, etime: '01:00:00' },
    { pid: 302, name: 'node', cmd: 'node node_modules/.bin/vitest', cwd: REPO, etime: '10:00' },
  ];

  it('lists what an agent started and is still running, and nothing that only looks like a tool', async () => {
    const { monitor } = setup(tree());
    const t0 = Date.now();
    for (const t of [t0, t0 + 46_000, t0 + 3_600_000]) {
      const byPid = new Map((await monitor.scan(t)).map((p) => [p.pid, p]));
      expect([...byPid.keys()].sort((a, b) => a - b), `+${(t - t0) / 1000}s`).toEqual([100, 101, 110, 121]);
      for (const pid of [110, 121]) {
        expect(byPid.get(pid)).toMatchObject({ category: 'child', agentPid: 100, pauseTarget: true });
        expect(byPid.get(pid)?.status).not.toBe('FROZEN');
      }
    }
  });

  it('lists a process an agent started once it is a few seconds old, so tool calls do not flicker by', async () => {
    const { monitor, procs } = setup(tree());
    const t0 = Date.now();
    expect((await monitor.scan(t0)).some((p) => p.pid === 130)).toBe(false);
    procs.find((p) => p.pid === 130)!.etime = '00:05';
    expect((await monitor.scan(t0 + 4_000)).find((p) => p.pid === 130)?.category).toBe('child');
  });

  it('lists nothing an agent started when its age is unknown', async () => {
    const procs = tree().map((p) => (p.pid === 110 ? { ...p, etime: undefined } : p));
    const { monitor } = setup(procs);
    expect((await monitor.scan(Date.now())).some((p) => p.pid === 110)).toBe(false);
  });

  it('no longer knows whose a process was once its agent is gone', async () => {
    // A known limit (README, "What strayps cannot see"): no memory of where a process came from
    const { monitor, procs, alive } = setup(tree());
    const t0 = Date.now();
    await monitor.scan(t0);
    alive.delete(100);
    alive.delete(105);
    alive.delete(106);
    procs.find((p) => p.pid === 110)!.ppid = 1;
    procs.find((p) => p.pid === 110)!.pgid = 105;
    const list = await monitor.scan(t0 + 2_000);
    expect(list.some((p) => p.pid === 110)).toBe(false);
  });

  it('never lists strayps itself, the wrappers that started it or what it runs', async () => {
    // started from an agent's shell: ending that agent's session must not end strayps
    const { monitor } = setup(
      [
        agent(100, REPO, { cpu: 1 }),
        { pid: 140, ppid: 100, name: 'node', cmd: `node ${REPO}/node_modules/.bin/tsx src/cli.ts watch`, etime: '20:00' },
        { pid: 141, ppid: 140, name: 'node', cmd: 'node src/cli.ts watch', etime: '20:00' },
        { pid: 142, ppid: 141, name: 'lsof', cmd: 'lsof -a -d cwd -p 100', etime: '00:30' },
      ],
      { selfPid: 141 },
    );
    const list = await monitor.scan(Date.now());
    expect(list.map((p) => p.pid)).toEqual([100]);
  });
});
