import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMonitor, STALE_QUIET_SEC } from '../src/core/process-monitor.js';
import { redactSecrets } from '../src/core/processes/command-line.js';
import { parseLsofCwdOutput, resolveProcessCwds } from '../src/core/processes/cwd.js';
import { MEMORY_READ_INTERVAL_MS, parseFootprintJson } from '../src/core/processes/memory.js';
import { defaultProcessAges, parseCpuTime, parsePsOutput } from '../src/core/processes/system.js';
import type { RawProcessInfo } from '../src/core/processes/types.js';
import { cleanupTmpDirs, createHarness } from './helpers/harness.js';
import { takeBlockedKills } from './helpers/kill-guard.js';

const REPO = '/work/current-repo';
const OTHER = '/work/other-repo';

interface Setup {
  monitor: ProcessMonitor;
  kills: Array<{ pid: number; signal: NodeJS.Signals | undefined }>;
  procs: RawProcessInfo[];
  alive: Set<number>;
}

function setup(
  procs: RawProcessInfo[],
  options: {
    killGraceMs?: number;
    selfPid?: number;
    processAge?: (pid: number) => number | undefined;
    processAges?: (pids: number[]) => Map<number, number>;
    processTree?: () => RawProcessInfo[] | undefined;
    rootDir?: string;
  } = {},
): Setup {
  const kills: Setup['kills'] = [];
  const alive = new Set(procs.map((p) => p.pid));
  const table = [...procs];
  const monitor = new ProcessMonitor({
    rootDir: options.rootDir ?? REPO,
    selfPid: options.selfPid ?? 999_999,
    killGraceMs: options.killGraceMs ?? 3000,
    processLister: async () => table.filter((p) => alive.has(p.pid)),
    processKiller: (pid, signal) => {
      kills.push({ pid, signal });
      return alive.has(pid);
    },
    processAlive: (pid) => alive.has(pid),
    processAge: options.processAge,
    processAges: options.processAges,
    // what pause sees when it looks again right after holding the agents: the table as it is now
    processTree: 'processTree' in options ? options.processTree : () => table.filter((p) => alive.has(p.pid)),
  });
  return { monitor, kills, procs: table, alive };
}

const agent = (pid: number, cwd: string, extra: Partial<RawProcessInfo> = {}): RawProcessInfo => ({
  pid,
  name: 'claude',
  cmd: 'claude --model claude-sonnet-5-5',
  cwd,
  cpu: 0,
  rssKb: 150_000,
  etime: '10:00',
  ...extra,
});

/** As macOS ps reports an editor's process: its name is the full path of the executable. */
const VSCODE_HELPER =
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';

const mcp = (pid: number, ppid: number, extra: Partial<RawProcessInfo> = {}): RawProcessInfo => ({
  pid,
  ppid,
  name: 'node',
  cmd: 'node /x/node_modules/.bin/some-mcp-server',
  cpu: 0,
  rssKb: 30_000,
  etime: '10:00',
  ...extra,
});

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

describe('ProcessMonitor termination', () => {
  it('does not put a process back into the list that was ended while a scan was waiting', async () => {
    // The candidates were checked against the processes being ended before the scan waited for
    // working directories and memory, up to 10 s (review, 20.11.2026)
    const procs = [agent(100, OTHER, { cpu: 1 }), mcp(101, 100)];
    let release: (value: Map<number, number>) => void = () => {};
    let block = false;
    const kills: number[] = [];
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      killGraceMs: 60_000,
      processLister: async () => procs,
      processKiller: (pid) => {
        kills.push(pid);
        return true;
      },
      processAlive: () => true,
      processAge: () => 600,
      memoryReader: (pids) =>
        block ? new Promise((resolve) => (release = resolve)) : Promise.resolve(new Map(pids.map((pid) => [pid, 1024]))),
    });
    const t0 = 1_000_000;
    await monitor.scan(t0);
    block = true;
    const scanning = monitor.scan(t0 + MEMORY_READ_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    const before = monitor.getProcesses().find((p) => p.pid === 101)!;
    expect(monitor.killProcess(101)).toBe(true);
    release(new Map());
    const list = await scanning;
    expect(list.some((p) => p.pid === 101)).toBe(false);
    expect(before.firstSeenAt).toBe(t0);
    expect(kills).toEqual([101]);
    monitor.stop();
  });

  it('only terminates processes from its own list, never an arbitrary PID', async () => {
    const { monitor, kills } = setup([agent(100, REPO)]);
    await monitor.scan(1_000);

    expect(monitor.killProcess(4242)).toBe(false);
    expect(monitor.killProcess(1)).toBe(false);
    expect(monitor.killProcess(process.pid)).toBe(false);
    expect(kills).toEqual([]);
  });

  it('asks nicely first: SIGTERM, and no SIGKILL if the process exits in time', async () => {
    vi.useFakeTimers();
    const { monitor, kills, alive } = setup([agent(100, REPO)]);
    await monitor.scan(1_000);
    const onKilled = vi.fn();
    monitor.on('process-killed', onKilled);

    expect(monitor.killProcess(100)).toBe(true);
    expect(kills).toEqual([{ pid: 100, signal: 'SIGTERM' }]);
    expect(monitor.getProcesses()).toHaveLength(0);

    alive.delete(100); // it exits cleanly
    await vi.advanceTimersByTimeAsync(3100);
    expect(kills).toHaveLength(1);
    expect(onKilled).toHaveBeenCalledTimes(1);
    expect(onKilled.mock.calls[0][0]).toMatchObject({ pid: 100, signal: 'SIGTERM' });
  });

  it('escalates to SIGKILL when SIGTERM is ignored, and hides the process meanwhile', async () => {
    vi.useFakeTimers();
    const { monitor, kills } = setup([agent(100, REPO)]);
    await monitor.scan(1_000);
    const onKilled = vi.fn();
    monitor.on('process-killed', onKilled);

    monitor.killProcess(100);
    // still running, but not offered for a second kill during the grace period
    expect(await monitor.scan(2_000)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3100);
    expect(kills).toEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGKILL' },
    ]);
    expect(onKilled).toHaveBeenLastCalledWith(
      expect.objectContaining({ pid: 100, signal: 'SIGKILL', escalated: true }),
    );
  });

  it('sends no SIGKILL when the PID belongs to a new process by the end of the grace period', async () => {
    // The process exited on SIGTERM and the system gave its PID to another one within 3 s
    vi.useFakeTimers();
    let age = 3600;
    const { monitor, kills } = setup([agent(100, REPO)], { processAge: () => age });
    await monitor.scan(1_000);
    monitor.killProcess(100);
    age = 1;
    await vi.advanceTimersByTimeAsync(3100);
    expect(kills).toEqual([{ pid: 100, signal: 'SIGTERM' }]);

    // the same, older process still running: SIGKILL as before
    const second = setup([agent(200, REPO)], { processAge: () => 3600 });
    await second.monitor.scan(1_000);
    second.monitor.killProcess(200);
    await vi.advanceTimersByTimeAsync(3100);
    expect(second.kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('sends no SIGTERM when the PID belongs to a process younger than the one listed', async () => {
    // The list is up to one scan old: the listed process exited and its PID went to a new one
    // before the answer came (external audit, 21.11.2026)
    let age = 1;
    const { monitor, kills } = setup([agent(100, REPO, { etime: '10:00' })], { processAge: () => age });
    await monitor.scan(1_000);
    expect(monitor.killProcess(100)).toBe(false);
    expect(kills).toEqual([]);

    // the listed process itself, older by now
    age = 605;
    expect(monitor.killProcess(100)).toBe(true);
    expect(kills).toEqual([{ pid: 100, signal: 'SIGTERM' }]);
    monitor.stop();
  });

  it('reads the real age with ps before SIGTERM and sends nothing to a PID younger than the listed process', async () => {
    // read-only: ps on the parent of this test process, listed as ten days old; the real killer is
    // used, and the suite-wide guard would record a kill that got through
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => [agent(process.ppid, REPO, { etime: '10-00:00:00' })],
    });
    await monitor.scan(1_000);
    expect(monitor.killProcess(process.ppid)).toBe(false);
    expect(takeBlockedKills()).toEqual([]);
    monitor.stop();
  });

  it('sends no SIGKILL to a PID that a younger process took before SIGTERM, once it can be read', async () => {
    // ps could not read the age before SIGTERM; three seconds later it reads a process younger
    // than the listed one, but older than the SIGTERM
    vi.useFakeTimers();
    const ages: Array<number | undefined> = [undefined, 5];
    const { monitor, kills } = setup([agent(100, REPO, { etime: '10:00' })], { processAge: () => ages.shift() });
    await monitor.scan(1_000);
    expect(monitor.killProcess(100)).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    expect(kills).toEqual([{ pid: 100, signal: 'SIGTERM' }]);
  });

  it('settles pending terminations when the monitor stops', async () => {
    vi.useFakeTimers();
    const { monitor, kills } = setup([agent(100, REPO)]);
    await monitor.scan(1_000);

    monitor.killProcess(100);
    monitor.stop();
    expect(kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);

    await vi.advanceTimersByTimeAsync(5000);
    expect(kills).toHaveLength(2);
  });

  it('pauses only the agents of the watched repository and what they started, and resumes them', async () => {
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      mcp(101, 100, { cwd: '/' }),
      // a test watcher the agent started
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vitest', cwd: REPO, cpu: 1, etime: '02:00' },
      agent(200, OTHER, { cpu: 1 }),
      mcp(201, 200, { cwd: OTHER }),
      // the developer's own dev server, started from a terminal in the same repository
      { pid: 10, ppid: 1, name: 'zsh', cmd: '-zsh' },
      { pid: 300, ppid: 10, name: 'node', cmd: `node ${REPO}/node_modules/.bin/tsx watch server.ts`, cwd: REPO, cpu: 1 },
      // an MCP server of the editor, which is not an agent and must not lose its tools
      { pid: 500, ppid: 1, name: 'Code Helper (Plugin)', cmd: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
      mcp(501, 500, { cwd: REPO }),
    ]);
    await monitor.scan(1_000);

    expect(monitor.getPauseTargets().map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 101, 102]);
    expect(monitor.pauseTargets().pids.sort((a, b) => a - b)).toEqual([100, 101, 102]);
    // held, not terminated: nothing leaves the list, nothing is killed
    expect(kills.map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGSTOP', '101:SIGSTOP', '102:SIGSTOP']);
    // the developer's dev server is not even listed: no agent started it
    expect(monitor.getProcesses().map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 101, 102, 200, 201, 501]);
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 101, 102]);
    // pausing again holds nothing twice
    expect(monitor.pauseTargets().pids).toEqual([]);

    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 101, 102]);
    expect(kills.slice(3).map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGCONT', '101:SIGCONT', '102:SIGCONT']);
    expect(monitor.getPausedPids()).toEqual([]);
  });

  it('never leaves an agent held when strayps stops', async () => {
    const { monitor, kills } = setup([agent(100, REPO, { cpu: 1 })]);
    await monitor.scan(1_000);
    monitor.pauseTargets();
    monitor.stop();
    expect(kills.map((k) => k.signal)).toEqual(['SIGSTOP', 'SIGCONT']);
  });

  it('does not report a held process as frozen, and says why it is quiet', async () => {
    const { monitor } = setup([agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })]);
    const onFrozen = vi.fn();
    monitor.on('process-frozen', onFrozen);
    const t0 = 5_000_000;
    await monitor.scan(t0);
    monitor.pauseTargets();
    const list = await monitor.scan(t0 + 10 * 60_000);
    for (const proc of list) {
      expect(proc.paused).toBe(true);
      expect(['IDLE', 'STANDBY', 'ACTIVE']).toContain(proc.status);
      expect(proc.reason).toBe('Paused by strayps; resume continues it');
    }
    expect(onFrozen).not.toHaveBeenCalled();
  });

  it('the default killer cannot reach a real process from inside the test suite', async () => {
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      // listed no older than it is: the age check before SIGTERM reads the real one
      processLister: async () => [agent(process.ppid, REPO, { etime: '00:00' })],
      // no processKiller: this is the real one
    });
    await monitor.scan(1_000);

    expect(monitor.killProcess(process.ppid)).toBe(false);
    expect(takeBlockedKills()).toEqual([{ pid: process.ppid, signal: 'SIGTERM' }]);
    monitor.stop();
  });
});

describe('ProcessMonitor pause and exit', () => {
  it('continues the processes it holds when strayps exits in any way, also by a crash', async () => {
    // The shutdown path resumed them, but a crash ended the process with them still stopped
    const { monitor, kills } = setup([agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })]);
    await monitor.scan(1_000);
    const before = process.listeners('exit');
    expect(monitor.pauseTargets().pids.sort((a, b) => a - b)).toEqual([100, 101]);
    const added = process.listeners('exit').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    // what process.exit() from the crash handler, or an uncaught exception, runs
    (added[0] as () => void)();
    expect(kills.filter((k) => k.signal === 'SIGCONT').map((k) => k.pid).sort((a, b) => a - b)).toEqual([100, 101]);
    expect(monitor.getPausedPids()).toEqual([]);
    expect(process.listeners('exit').filter((listener) => !before.includes(listener))).toEqual([]);
  });

  it('does not hold a PID that names a younger process by the time pause acts', async () => {
    // The list is up to one scan old. A process held under a reused PID would be taken for a new one
    // by the next scan, dropped from what strayps holds and never continued (external audit, 21.11.2026)
    let ages = new Map<number, number>();
    const { monitor, kills } = setup([agent(100, REPO), mcp(101, 100, { cwd: '/' })], { processAges: () => ages });
    await monitor.scan(1_000);
    ages = new Map([[100, 600], [101, 1]]);
    monitor.pauseTargets();
    expect(kills).toEqual([{ pid: 100, signal: 'SIGSTOP' }]);
    monitor.resumePaused();
  });

  it('keeps listing and holding a paused process that loses its place in the tree, and continues it', async () => {
    // A held browser whose MCP server was ended moved to PID 1, left the list, left the set of
    // held processes, and stayed stopped: resume and the exit hook no longer knew it (review, 20.11.2026)
    const { monitor, kills, procs, alive } = setup([
      agent(100, REPO, { cpu: 1 }),
      mcp(101, 100, { cwd: '/' }),
      { pid: 121, ppid: 101, name: 'Chromium', cmd: 'Chromium --headless', etime: '05:00' },
    ]);
    const t0 = 1_000_000;
    await monitor.scan(t0);
    expect(monitor.pauseTargets().pids.sort((a, b) => a - b)).toEqual([100, 101, 121]);

    alive.delete(101);
    Object.assign(procs.find((p) => p.pid === 121)!, { ppid: 1, pgid: 101, etime: '05:02' });
    const held = (await monitor.scan(t0 + 2_000)).find((p) => p.pid === 121);
    expect(held).toMatchObject({ paused: true });
    expect(monitor.getPausedPids()).toContain(121);

    expect(monitor.resumePaused()).toContain(121);
    expect(kills.filter((k) => k.signal === 'SIGCONT').map((k) => k.pid)).toContain(121);
  });

  it('holds the whole tree of this repository\'s agents, shells and young tool calls included, and lists what it holds', async () => {
    // A tool call younger than 5 s, and the shell running a loop around it, kept running while
    // the agent was held: neither was listed, so neither was held (review, 20.11.2026)
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 105, ppid: 100, name: 'bash', cmd: 'bash -c while true; do rm -f out.txt; sleep 1; done', cwd: REPO, etime: '01:00' },
      { pid: 106, ppid: 105, name: 'sleep', cmd: 'sleep 1', cwd: REPO, etime: '00:00' },
      agent(200, OTHER, { cpu: 1 }),
      { pid: 201, ppid: 200, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: OTHER, etime: '01:00' },
    ]);
    const t0 = 1_000_000;
    const listed = await monitor.scan(t0);
    expect(listed.some((p) => p.pid === 105 || p.pid === 106)).toBe(false);

    const targets = monitor.getPauseTargets();
    expect(targets.map((t) => [t.pid, t.listed]).sort()).toEqual([[100, true], [105, false], [106, false]]);
    expect(targets.find((t) => t.pid === 105)?.cmd).toContain('bash -c while true');
    expect(monitor.pauseTargets().pids.sort((a, b) => a - b)).toEqual([100, 105, 106]);
    expect(kills.map((k) => k.pid).sort((a, b) => a - b)).toEqual([100, 105, 106]);

    // what is held stays in view until it is continued
    const byPid = new Map((await monitor.scan(t0 + 2_000)).map((p) => [p.pid, p]));
    expect(byPid.get(105)).toMatchObject({ paused: true, category: 'child', agentPid: 100 });
    expect(byPid.get(106)).toMatchObject({ paused: true, category: 'child' });
    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 105, 106]);
  });

  it('never holds strayps itself, its wrappers, the agent that started it or what it runs, while still holding other agents in the repo', async () => {
    // Holding the agent that spawned strayps freezes whatever owns strayps's stdin/stdout, leaving
    // no way to resume (maintainer decision, 22.11.2026)
    const { monitor, kills } = setup(
      [
        agent(100, REPO, { cpu: 1 }),
        mcp(101, 100, { cwd: REPO }),
        { pid: 105, ppid: 100, name: 'bash', cmd: 'bash -c sleep 30', cwd: REPO, etime: '00:01' },
        { pid: 140, ppid: 100, name: 'node', cmd: `node ${REPO}/node_modules/.bin/tsx src/cli.ts watch`, etime: '20:00' },
        { pid: 141, ppid: 140, name: 'node', cmd: 'node src/cli.ts watch', etime: '20:00' },
        { pid: 142, ppid: 141, name: 'lsof', cmd: 'lsof -a -d cwd -p 100', etime: '00:00' },
        // another agent in this repo, and a sub-agent started by 100 on another branch, are still held
        agent(160, REPO, { ppid: 100, cpu: 1 }),
        agent(200, REPO, { cpu: 1 }),
        mcp(201, 200, { cwd: REPO }),
      ],
      { selfPid: 141 },
    );
    const listed = await monitor.scan(1_000);
    // the launching agent stays visible in the list, just not a pause target
    expect(listed.find((p) => p.pid === 100)).toMatchObject({ category: 'agent', inWatchedRepo: true, pauseTarget: false });
    expect(monitor.getPauseTargets().map((t) => t.pid).sort((a, b) => a - b)).toEqual([160, 200, 201]);
    expect(monitor.pauseTargets().pids.sort((a, b) => a - b)).toEqual([160, 200, 201]);
    expect(kills.map((k) => k.pid).sort((a, b) => a - b)).toEqual([160, 200, 201]);
    monitor.resumePaused();
  });

  it('keeps holding processes when the system wall clock jumps forward relative to monotonic ps etime', async () => {
    // On Linux ps measures etime with a monotonic clock: a forward system-clock jump (NTP, VM sync)
    // made expected age jump ahead of etime, so stillHeld forgot the hold and left the process stopped
    vi.useFakeTimers();
    let ages = new Map<number, number>([
      [100, 602],
      [105, 62],
    ]);
    const { monitor, procs } = setup(
      [
        agent(100, REPO, { cpu: 1 }),
        { pid: 105, ppid: 100, name: 'bash', cmd: 'bash -c make', cwd: REPO, etime: '01:00' },
      ],
      { processAges: () => ages },
    );
    await monitor.scan();
    const asked = monitor.getPauseTargets();

    // 2 real seconds pass, but the system wall clock jumps forward by 60 seconds before the user answers
    vi.advanceTimersByTime(2_000);
    vi.setSystemTime(Date.now() + 60_000);
    expect(monitor.pauseTargets(asked)).toMatchObject({ pids: [100, 105], gone: [] });

    // another 2 real seconds pass and the wall clock jumps forward by another 60 seconds; ps etime only grew by 4 s
    vi.advanceTimersByTime(2_000);
    vi.setSystemTime(Date.now() + 60_000);
    procs[0].etime = '10:04';
    procs[1].etime = '01:04';
    const list = await monitor.scan();
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 105]);
    expect(list.find((p) => p.pid === 105)).toMatchObject({ paused: true });

    // and a backward wall-clock jump keeps them held too
    vi.advanceTimersByTime(2_000);
    vi.setSystemTime(Date.now() - 120_000);
    procs[0].etime = '10:06';
    procs[1].etime = '01:06';
    await monitor.scan();
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 105]);

    // a real PID reuse is still detected and forgotten
    vi.advanceTimersByTime(2_000);
    procs[0].etime = '10:08';
    Object.assign(procs[1], { ppid: 1, pgid: 1, name: 'cupsd', cmd: '/usr/sbin/cupsd', etime: '00:01' });
    await monitor.scan();
    expect(monitor.getPausedPids()).toEqual([100]);
    expect(monitor.resumePaused()).toEqual([100]);
  });

  it('does not count a new process as held when the PID it held was handed on', async () => {
    const { monitor, procs } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 105, ppid: 100, name: 'bash', cmd: 'bash -c make', cwd: REPO, etime: '01:00' },
    ]);
    const t0 = 1_000_000;
    await monitor.scan(t0);
    monitor.pauseTargets();
    // 105 ended, and an unrelated process got the PID
    Object.assign(procs.find((p) => p.pid === 105)!, { ppid: 1, pgid: 1, name: 'cupsd', cmd: '/usr/sbin/cupsd', etime: '00:01' });
    const list = await monitor.scan(t0 + 2_000);
    expect(list.some((p) => p.pid === 105)).toBe(false);
    expect(monitor.getPausedPids()).toEqual([100]);
  });

  it('removes its exit hook again once everything held is continued', async () => {
    const { monitor } = setup([agent(100, REPO, { cpu: 1 })]);
    await monitor.scan(1_000);
    const before = process.listeners('exit').length;
    monitor.pauseTargets();
    monitor.resumePaused();
    expect(process.listeners('exit')).toHaveLength(before);
  });
});

describe('ProcessMonitor pause: what a confirmed agent starts while the question is open', () => {
  it('holds it too, parents before what they run, and names it', async () => {
    // An agent at work starts its next tool call while the person reads the question: the agent was
    // held, the call ran on until a second pause (maintainer decision, 22.11.2026)
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })]);
    await monitor.scan(1_000);
    const asked = monitor.getPauseTargets();
    // no scan has seen these yet
    procs.push(
      { pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c npm test', cwd: REPO, etime: '00:01' },
      { pid: 111, ppid: 110, name: 'node', cmd: 'node node_modules/.bin/vitest run', etime: '00:00' },
    );
    alive.add(110).add(111);

    const outcome = monitor.pauseTargets(asked);
    expect(outcome).toEqual({ pids: [100, 101, 110, 111], gone: [], notAsked: [], alsoHeld: [110, 111] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['100:SIGSTOP', '101:SIGSTOP', '110:SIGSTOP', '111:SIGSTOP']);

    // listed and held until resume continues them
    const byPid = new Map((await monitor.scan(2_000)).map((p) => [p.pid, p]));
    expect(byPid.get(110)).toMatchObject({ paused: true, category: 'child', agentPid: 100 });
    expect(byPid.get(111)).toMatchObject({ paused: true });
    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 101, 110, 111]);
  });

  it('never holds a new agent or what it runs, and names it without waiting for a scan', async () => {
    // A codex started by the confirmed agent ran on and nothing said so: only a finished scan
    // could report it (safety review, 22.11.2026)
    const { monitor, kills, procs, alive } = setup([
      agent(100, REPO, { cpu: 1 }),
      // an agent only the last scan can tell: its MCP server is gone by the time pause looks
      { pid: 180, ppid: 100, name: 'node', cmd: 'node /opt/helper/agent.js', cwd: REPO, etime: '05:00' },
      mcp(181, 180, { cwd: REPO }),
    ]);
    monitor.setAgentNames(['vibe']);
    await monitor.scan(1_000);
    expect(monitor.getProcesses().find((p) => p.pid === 180)).toMatchObject({ category: 'agent', detectedBy: 'mcp-client' });
    const asked = monitor.getPauseTargets().filter((t) => t.pid === 100);
    alive.delete(181);
    const started: RawProcessInfo[] = [
      // an agent by its name, started by the confirmed one, with a tool call of its own
      { pid: 120, ppid: 100, name: 'codex', cmd: 'codex exec fix-the-build', cwd: REPO, etime: '00:01' },
      { pid: 121, ppid: 120, name: 'bash', cmd: 'bash -c make', etime: '00:00' },
      // an agent by the MCP server it starts, whatever it is called
      { pid: 130, ppid: 100, name: 'node', cmd: 'node /opt/runner/main.js', etime: '00:01' },
      { pid: 131, ppid: 130, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '00:00' },
      // the same through a shell and npx: the shell is the agent's tool call, the runner is not
      { pid: 170, ppid: 100, name: 'bash', cmd: 'bash -c node /opt/other/main.js', etime: '00:01' },
      { pid: 171, ppid: 170, name: 'node', cmd: 'node /opt/other/main.js', etime: '00:01' },
      { pid: 172, ppid: 171, name: 'npm', cmd: 'npm exec -y mcp-server-fetch', etime: '00:00' },
      { pid: 173, ppid: 172, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-fetch', etime: '00:00' },
      // an agent named in the `agents` setting
      { pid: 160, ppid: 100, name: 'vibe', cmd: 'vibe', etime: '00:01' },
    ];
    procs.push(...started);
    for (const p of started) alive.add(p.pid);

    const outcome = monitor.pauseTargets(asked);
    expect(outcome.pids).toEqual([100, 170]);
    expect(outcome.alsoHeld).toEqual([170]);
    expect(outcome.notAsked.sort((a, b) => a - b)).toEqual([120, 130, 160, 171, 180]);
    expect(kills.map((k) => k.pid)).toEqual([100, 170]);
    monitor.resumePaused();
  });

  it('never holds or offers an editor, a session it did not ask about, another repository, or a process being ended', async () => {
    const { monitor, kills, procs, alive } = setup([
      agent(100, REPO, { cpu: 1 }),
      agent(200, OTHER, { cpu: 1 }),
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
    ]);
    await monitor.scan(1_000);
    // ended a moment ago and still in its grace period
    expect(monitor.killProcess(102)).toBe(true);
    const asked = monitor.getPauseTargets();
    expect(asked.map((t) => t.pid)).toEqual([100]);
    const started: RawProcessInfo[] = [
      // an editor window the agent opened
      { pid: 140, ppid: 100, name: VSCODE_HELPER, cmd: `${VSCODE_HELPER} --type=utility`, etime: '00:01' },
      { pid: 141, ppid: 140, name: 'node', cmd: 'node extension-host.js', etime: '00:00' },
      // a new session in this repository, started from a terminal: only a scan can place it
      { pid: 10, ppid: 1, name: 'zsh', cmd: '-zsh', etime: '01:00' },
      agent(150, REPO, { ppid: 10, etime: '00:01' }),
      { pid: 151, ppid: 150, name: 'bash', cmd: 'bash -c ls', etime: '00:00' },
      // what the session in another repository starts
      { pid: 210, ppid: 200, name: 'bash', cmd: 'bash -c make', cwd: OTHER, etime: '00:00' },
    ];
    procs.push(...started);
    for (const p of started) alive.add(p.pid);

    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '100:SIGSTOP']);
    monitor.resumePaused();
  });

  it('never makes an editor, app or terminal an agent started a pause target, nor the tool processes in it', async () => {
    // pause held them once a question had shown them, and its hint offered them (safety review, 22.11.2026)
    const { monitor } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 140, ppid: 100, name: VSCODE_HELPER, cmd: `${VSCODE_HELPER} --type=utility`, cwd: REPO, etime: '05:00' },
      { pid: 141, ppid: 140, name: 'node', cmd: 'node node_modules/.bin/tsc --watch', cwd: REPO, etime: '05:00' },
      { pid: 142, ppid: 140, name: 'bash', cmd: 'bash -c sleep 100', cwd: REPO, etime: '00:01' },
      { pid: 150, ppid: 100, name: '/usr/bin/tmux', cmd: 'tmux new-session -d', cwd: REPO, etime: '05:00' },
      { pid: 151, ppid: 150, name: '/bin/zsh', cmd: '-zsh', cwd: REPO, etime: '05:00' },
    ]);
    await monitor.scan(1_000);
    expect(monitor.getPauseTargets().map((t) => t.pid)).toEqual([100]);
  });

  it('never takes an IDE an agent started for a new agent because it runs an MCP server', async () => {
    // Android Studio is in the list of apps pause never holds, but not in the host patterns: as the
    // client of its MCP server it became an agent, was named, and the next pause held it (safety review, 22.11.2026)
    const studio = '/Applications/Android Studio.app/Contents/MacOS/studio';
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })]);
    await monitor.scan(1_000);
    const asked = monitor.getPauseTargets();
    const started: RawProcessInfo[] = [
      { pid: 140, ppid: 100, name: studio, cmd: studio, cwd: REPO, etime: '05:00' },
      mcp(141, 140, { cwd: REPO, etime: '05:00' }),
    ];
    procs.push(...started);
    for (const p of started) alive.add(p.pid);
    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [] });
    expect(kills.map((k) => k.pid)).toEqual([100]);
    monitor.resumePaused();

    const listed = await monitor.scan(3_000);
    expect(listed.some((p) => p.pid === 140 && p.category === 'agent')).toBe(false);
    expect(monitor.getPauseTargets().map((t) => t.pid)).toEqual([100]);
  });

  it('holds the tool calls of an agent whose project path names an IDE or a terminal', async () => {
    // A word in a path made every tool call in ~/WebstormProjects look like the IDE: not listed for
    // pause, not held, not named (safety review, 22.11.2026)
    const node = (pid: number, ppid: number, script: string): RawProcessInfo => ({ pid, ppid, name: '/usr/local/bin/node', cmd: `node ${script}`, etime: '05:00' });
    const program = (pid: number, ppid: number, file: string, args: string): RawProcessInfo => ({ pid, ppid, name: file, cmd: `${file} ${args}`, etime: '05:00' });
    const cases: Array<{ root: string; tools: RawProcessInfo[] }> = [
      { root: '/Users/x/WebstormProjects/app', tools: [node(110, 100, '/Users/x/WebstormProjects/app/node_modules/.bin/vite')] },
      { root: '/Users/x/PycharmProjects/app', tools: [program(110, 100, '/Users/x/PycharmProjects/app/.venv/bin/python', '-m pytest')] },
      { root: '/Users/x/src/xterm.js', tools: [node(110, 100, '/Users/x/src/xterm.js/node_modules/.bin/tsc --watch')] },
      // Xcode's tools live in its bundle, but are not the app
      { root: '/Users/x/src/ios-app', tools: [program(110, 100, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild', 'test')] },
      // framework builds of Python run as an app bundle's program
      {
        root: '/Users/x/src/django-app',
        tools: [program(110, 100, '/opt/homebrew/Cellar/python@3.12/3.12.4/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python', 'manage.py runserver')],
      },
      {
        root: '/Users/x/src/scripts',
        tools: [program(110, 100, '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python', '-m pytest')],
      },
      // the browser an agent's MCP server drives
      {
        root: '/Users/x/src/web',
        tools: [
          mcp(101, 100, { cmd: 'node /x/node_modules/.bin/mcp-server-playwright' }),
          program(110, 101, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--remote-debugging-pipe --user-data-dir=/tmp/x'),
        ],
      },
      {
        root: '/Users/x/src/web',
        tools: [program(110, 100, '/Users/x/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium', '--headless')],
      },
      // the Electron app the agent works on
      {
        root: '/Users/x/src/desktop',
        tools: [program(110, 100, '/Users/x/src/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '.')],
      },
    ];
    for (const { root, tools } of cases) {
      const { monitor, procs, alive } = setup([agent(100, root, { cpu: 1 }), ...tools.map((t) => ({ cwd: root, ...t }))], { rootDir: root });
      await monitor.scan(1_000);
      expect(monitor.getPauseTargets().map((t) => t.pid).sort((a, b) => a - b), root).toEqual([100, ...tools.map((t) => t.pid)]);
      // and the same call, started while the question is open
      const asked = monitor.getPauseTargets();
      const last = tools[tools.length - 1];
      procs.push({ ...last, pid: 199, cwd: root, etime: '00:01' });
      alive.add(199);
      expect(monitor.pauseTargets(asked).alsoHeld, root).toEqual([199]);
      monitor.resumePaused();
    }
  });

  it('compares ages from the moment ps read them, so a slow ps makes no agent look gone', async () => {
    // Ages were taken as of the scan's start: with ps 2.5 s late, the confirmed agent counted as
    // another process, and a held one was forgotten while stopped (safety review, 22.11.2026)
    vi.useFakeTimers();
    let slow = true;
    const table: RawProcessInfo[] = [agent(100, REPO, { cpu: 1 })];
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => {
        if (slow) vi.advanceTimersByTime(2_500);
        return table.map((p) => ({ ...p }));
      },
      processKiller: () => true,
      processTree: () => table.map((p) => ({ ...p })),
      // as ps reads them now: the table holds the ages of the last read
      processAges: (pids) => new Map(pids.map((pid) => [pid, 600])),
    });
    const t0 = Date.now();
    await monitor.scan(t0);
    expect(monitor.pauseTargets(monitor.getPauseTargets())).toMatchObject({ pids: [100], gone: [] });

    // the next scan is fast, 2 s later: the agent is 10:02 old
    slow = false;
    vi.advanceTimersByTime(2_000);
    table[0].etime = '10:02';
    await monitor.scan(Date.now());
    expect(monitor.getPausedPids()).toEqual([100]);
    expect(monitor.resumePaused()).toEqual([100]);
  });

  it('keeps holding what it held while a scan was reading the process table, and continues it', async () => {
    // The scan read its list, waited for lsof, and then forgot every hold its list did not have:
    // those processes stayed stopped (safety review, 22.11.2026)
    const table: RawProcessInfo[] = [agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })];
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    const kills: Array<{ pid: number; signal?: NodeJS.Signals }> = [];
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => {
        const list = table.map((p) => ({ ...p }));
        if (gate) await gate;
        return list;
      },
      processKiller: (pid, signal) => {
        kills.push({ pid, signal });
        return table.some((p) => p.pid === pid);
      },
      processTree: () => table.map((p) => ({ ...p })),
      // as ps reads them when pause acts, 2 s after the first scan: the tool calls are new
      processAges: (pids) => new Map(table.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.etime === '00:00' ? 0 : 602])),
    });
    await monitor.scan(1_000);
    const asked = monitor.getPauseTargets();

    // the MCP server ends; this scan reads the table and waits
    table.splice(1, 1);
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const scanning = monitor.scan(3_000);
    // then the agent starts a tool call, which gets the MCP server's PID, and another one
    table.push(
      { pid: 101, ppid: 100, name: 'bash', cmd: 'bash -c make', etime: '00:00' },
      { pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c npm test', etime: '00:00' },
    );
    expect(monitor.pauseTargets(asked).pids.sort((a, b) => a - b)).toEqual([100, 101, 110]);
    open();
    await scanning;

    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 101, 110]);
    // the next scan, 4 s after the first one
    table[0].etime = '10:04';
    table[1].etime = '00:02';
    table[2].etime = '00:02';
    const listed = await monitor.scan(5_000);
    expect(listed.filter((p) => p.paused).map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 101, 110]);
    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 101, 110]);
  });

  it('names what still runs when its looks run out instead of claiming it held everything', async () => {
    // a tool call that forks one level deeper between each look and its SIGSTOP
    let looks = 0;
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })], {
      processTree: () => {
        looks += 1;
        const pid = 109 + looks;
        procs.push({ pid, ppid: looks === 1 ? 100 : pid - 1, name: 'sh', cmd: `sh -c level-${looks}`, etime: '00:00' });
        alive.add(pid);
        return procs.filter((p) => alive.has(p.pid));
      },
    });
    await monitor.scan(1_000);
    const outcome = monitor.pauseTargets(monitor.getPauseTargets());
    expect(outcome.alsoHeld).toEqual([110, 111, 112]);
    expect(outcome.notAsked).toEqual([113]);
    expect(looks).toBe(4);
    expect(kills.map((k) => k.pid)).toEqual([100, 110, 111, 112]);
    monitor.resumePaused();
  });

  it('keeps what it found held across later scans when the clock moved on before the answer', async () => {
    // the ages from the new look belong to the moment of the answer, not to the last scan
    vi.useFakeTimers();
    const { monitor, procs, alive } = setup([agent(100, REPO, { cpu: 1 })]);
    const t0 = 1_000_000;
    await monitor.scan(t0);
    const asked = monitor.getPauseTargets();
    procs.push({ pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c make', etime: '00:04' });
    alive.add(110);
    vi.advanceTimersByTime(5_000);
    expect(monitor.pauseTargets(asked).alsoHeld).toEqual([110]);

    // 7 s after the scan: the agent is 10:07 old, the tool call 4 + 2 s
    procs[0].etime = '10:07';
    procs[1].etime = '00:06';
    await monitor.scan(t0 + 7_000);
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 110]);
    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 110]);
  });

  it('does not hold a PID from the last scan that is younger by now than that process would be', async () => {
    // seen 3 s old, then 5 s pass: a process 4 s old under that PID is another one (safety review, 22.11.2026)
    vi.useFakeTimers();
    let ages = new Map<number, number>();
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })], {
      processTree: () => undefined,
      processAges: () => ages,
    });
    const t0 = 1_000_000;
    await monitor.scan(t0);
    const asked = monitor.getPauseTargets();
    procs.push({ pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c make', etime: '00:03' });
    alive.add(110);
    await monitor.scan(t0 + 2_000);
    vi.advanceTimersByTime(5_000);
    ages = new Map([[100, 607], [110, 4]]);
    expect(monitor.pauseTargets(asked)).toMatchObject({ pids: [100], alsoHeld: [] });
    expect(kills.map((k) => k.pid)).toEqual([100]);
    monitor.resumePaused();
  });

  it('looks again until what it holds has started nothing new', async () => {
    let looks = 0;
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })], {
      processTree: () => {
        looks += 1;
        // the tool call forks between the first look and its SIGSTOP
        if (looks === 2) {
          procs.push({ pid: 112, ppid: 111, name: 'node', cmd: 'node worker.js', etime: '00:00' });
          alive.add(112);
        }
        return procs.filter((p) => alive.has(p.pid));
      },
    });
    await monitor.scan(1_000);
    const asked = monitor.getPauseTargets();
    procs.push(
      { pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c npm test', etime: '00:00' },
      { pid: 111, ppid: 110, name: 'npm', cmd: 'npm test', etime: '00:00' },
    );
    alive.add(110).add(111);

    expect(monitor.pauseTargets(asked).alsoHeld).toEqual([110, 111, 112]);
    expect(kills.map((k) => k.pid)).toEqual([100, 110, 111, 112]);
    // the third look found nothing new, and there is no fourth
    expect(looks).toBe(3);
    monitor.resumePaused();
  });

  it('holds what the last scan saw when the process table cannot be read again, and only that', async () => {
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })], { processTree: () => undefined });
    const t0 = 1_000_000;
    await monitor.scan(t0);
    const asked = monitor.getPauseTargets();
    procs.push({ pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c npm test', cwd: REPO, etime: '00:01' });
    alive.add(110);
    await monitor.scan(t0 + 2_000);
    // started after that scan: nothing can know it
    procs.push({ pid: 111, ppid: 110, name: 'node', cmd: 'node node_modules/.bin/vitest run', etime: '00:00' });
    alive.add(111);

    const outcome = monitor.pauseTargets(asked);
    expect(outcome).toEqual({ pids: [100, 110], gone: [], notAsked: [], alsoHeld: [110] });
    expect(kills.map((k) => k.pid)).toEqual([100, 110]);
    monitor.resumePaused();
  });

  it('looks for nothing when it held no agent', async () => {
    let looks = 0;
    const { monitor } = setup([agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })], {
      processTree: () => {
        looks += 1;
        return [];
      },
    });
    await monitor.scan(1_000);
    // only the MCP server was confirmed
    const asked = monitor.getPauseTargets().filter((t) => t.pid === 101);
    expect(monitor.pauseTargets(asked)).toMatchObject({ pids: [101], alsoHeld: [], notAsked: [100] });
    expect(looks).toBe(0);
    monitor.resumePaused();
  });

  it('does not hold what it found when its PID names a younger process by the time it acts', async () => {
    let ages = new Map<number, number>();
    const { monitor, kills, procs, alive } = setup([agent(100, REPO, { cpu: 1 })], { processAges: () => ages });
    await monitor.scan(1_000);
    const asked = monitor.getPauseTargets();
    procs.push({ pid: 110, ppid: 100, name: 'bash', cmd: 'bash -c make', etime: '05:00' });
    alive.add(110);
    ages = new Map([[100, 600], [110, 1]]);
    expect(monitor.pauseTargets(asked)).toMatchObject({ pids: [100], alsoHeld: [] });
    expect(kills).toEqual([{ pid: 100, signal: 'SIGSTOP' }]);
    monitor.resumePaused();
  });
});

describe('ProcessMonitor bookkeeping', () => {
  it('forgets the history of a process it ended, so a new process under its PID starts clean', async () => {
    const h = createHarness({ procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 120_000, etime: '03-00:00:00', cpuTimeSec: 10 }], killGraceMs: 0 });
    await h.monitor.scan();
    // internal state, read through a cast
    const state = h.monitor as unknown as { cpuSamples: Map<number, unknown>; children: Map<number, unknown>; footprints: Map<number, unknown> };
    expect([state.cpuSamples.has(300), state.children.has(300), state.footprints.has(300)]).toEqual([true, true, true]);
    expect(h.monitor.killProcess(300)).toBe(true);
    await h.monitor.scan();
    expect([state.cpuSamples.has(300), state.children.has(300), state.footprints.has(300)]).toEqual([false, false, false]);
  });

  it('reads the age of several processes with one ps call, and keeps those it found', () => {
    // read-only: ps on this process and on a PID that is almost surely free
    const ages = defaultProcessAges([process.pid, 99_998]);
    expect(ages.get(process.pid)).toBeGreaterThanOrEqual(0);
    expect([...ages.keys()].every((pid) => pid === process.pid || pid === 99_998)).toBe(true);
    expect(defaultProcessAges([])).toEqual(new Map());
  });
});

describe('secrets in command lines', () => {
  it('shows command lines with token, key and password values and URL credentials redacted', async () => {
    const { monitor } = setup([
      mcp(70, 69, { cmd: 'node /x/node_modules/.bin/mcp-server-api --api-key sk-live-123 --token=abc API_SECRET=s3cr3t https://me:pw@example.com/x' }),
    ]);
    const [proc] = await monitor.scan(Date.now());
    expect(proc.category).toBe('mcp');
    expect(proc.cmd).not.toMatch(/sk-live-123|abc|s3cr3t|me:pw/);
    expect(redactSecrets('tool --api-key sk-1 --password hunter2 --verbose')).toBe('tool --api-key [redacted] --password [redacted] --verbose');
    expect(redactSecrets('git clone https://user:pw@github.com/a/b')).toBe('git clone https://[redacted]@github.com/a/b');
    // flags that only look alike keep their value when it is another flag
    expect(redactSecrets('node server --auth-mode -v')).toBe('node server --auth-mode -v');
    // only where a flag starts: a path that contains "auth" keeps the word after it
    expect(redactSecrets('/srv/mcp-auth-proxy.js /Users/x/repoA')).toBe('/srv/mcp-auth-proxy.js /Users/x/repoA');
    expect(redactSecrets('node --no-auth server.js')).toBe('node --no-auth server.js');
    expect(redactSecrets('tool --key abc --openai-key def')).toBe('tool --key [redacted] --openai-key [redacted]');
    expect(redactSecrets('curl -H x-api-key: v123 -H Authorization: token ghp_abcdefghijklmnop')).toBe(
      'curl -H x-api-key: [redacted] -H Authorization: token [redacted]',
    );
  });

  it('redacts query parameters, JSON keys, quoted values, tokens before the @ of a URL and common token formats', () => {
    // each of these was shown in full (external audit, 21.11.2026)
    const cases: Array<[string, string]> = [
      ['mcp-remote https://api.example.com/sse?api_key=SUPERSECRET1&foo=bar', 'mcp-remote https://api.example.com/sse?api_key=[redacted]&foo=bar'],
      ['mcp-remote https://api.example.com/sse?x=1&token=SUPERSECRET1', 'mcp-remote https://api.example.com/sse?x=1&token=[redacted]'],
      [`x --headers '{"x-api-key":"SUPERSECRET1"}'`, `x --headers '{"x-api-key":"[redacted]"}'`],
      ['x --headers {"Authorization": "Bearer A B", "accept": "json"}', 'x --headers {"Authorization": "[redacted]", "accept": "json"}'],
      // quotes that are part of the argument (a command for sh -c): up to the closing one
      ['sh -c x --token "my secret with spaces" --other', 'sh -c x --token [redacted] --other'],
      ["sh -c x --token='my secret' --next", 'sh -c x --token=[redacted] --next'],
      ['sh -c x API_KEY="a b c" y', 'sh -c x API_KEY=[redacted] y'],
      ['git clone https://SUPERSECRETTOKEN1@github.com/a/b', 'git clone https://[redacted]@github.com/a/b'],
      ['curl --header=Authorization: token abc123', 'curl --header=Authorization: token [redacted]'],
      [
        'x AIzaSyA1234567890abcdefghijklmnopqrstu AKIAIOSFODNN7EXAMPLE npm_abcdefghijklmnopqrstuvwxyz0123456789 glpat-abcdefghij1234567890',
        'x [redacted] [redacted] [redacted] [redacted]',
      ],
    ];
    for (const [cmd, shown] of cases) expect(redactSecrets(cmd), cmd).toBe(shown);

    // shapes the first rewrite showed in full and the old patterns had hidden (safety review, 21.11.2026)
    const kept: Array<[string, string]> = [
      ['curl -H Accept:json,Authorization:Basic dXNlcjpwYXNz https://x', 'curl -H Accept:json,Authorization:Basic [redacted] https://x'],
      ['x {Authorization: token abc123def}', 'x {Authorization: token [redacted]}'],
      ['x headers:Authorization:token abc123def', 'x headers:Authorization:token [redacted]'],
      ['x -H x-api-key : v123', 'x -H x-api-key : [redacted]'],
      ['sh -c curl -H x-api-key:"abc123" https://x', 'sh -c curl -H x-api-key:"[redacted]" https://x'],
      ['sh -c curl -H "x-api-key: abc 123" https://x', 'sh -c curl -H "x-api-key: [redacted]" https://x'],
      ["sh -c curl -H 'Authorization: Bearer abc def'", "sh -c curl -H 'Authorization: Bearer [redacted]'"],
      ['redis-cli -u redis://default:pa#ss@host:6379', 'redis-cli -u redis://[redacted]@host:6379'],
      ['psql postgres://u:p?w@h/db', 'psql postgres://[redacted]@h/db'],
      ['pip install -ihttps://user:tok@host/simple x', 'pip install -ihttps://[redacted]@host/simple x'],
      [`x ${'a'.repeat(40)}+db://u:pw@h`, `x ${'a'.repeat(40)}+db://[redacted]@h`],
      ['node --NO-auth secret-value', 'node --NO-auth secret-value'],
    ];
    for (const [cmd, shown] of kept) expect(redactSecrets(cmd), cmd).toBe(shown);

    // what only looks alike stays readable
    for (const cmd of [
      'npx -y @modelcontextprotocol/server-github@1.2.3 https://registry.npmjs.org/@scope/pkg',
      'docker run -p 8080:80 -v /data:/run/data image:latest localhost:3000',
      'node --inspect=127.0.0.1:9229 x.js PATH=/usr/bin:/bin',
      'claude --model claude-sonnet-5-5 --permission-mode acceptEdits',
      'x --token',
      'x --token= y',
    ]) {
      expect(redactSecrets(cmd), cmd).toBe(cmd);
    }
  });

  it('takes milliseconds for a command line of 100,000 characters, not seconds per scan', async () => {
    // One argument of 50,000 letters held every scan for 2.7 s: the patterns started anew at each
    // character (external audit, 21.11.2026). macOS allows command lines of 1 MB.
    const n = 100_000;
    const hostile = [
      ' ' + 'a'.repeat(n),
      ' ' + 'token'.repeat(n / 5),
      ' ' + 'x-'.repeat(n / 2),
      ' --' + 'a-'.repeat(n / 2),
      ' ' + 'a://b:'.repeat(n / 6),
      ' "token":"' + 'x'.repeat(n),
      ' ?' + 'token=a&'.repeat(n / 8),
      ' --token "a'.repeat(n / 11),
      ' ' + 'sk-'.repeat(n / 3),
      ' "token:a'.repeat(n / 9),
      ' token:"a'.repeat(n / 9),
      ' ' + 'token:a,'.repeat(n / 8),
      ' x://' + 'a:'.repeat(n / 2),
    ];
    for (const cmd of hostile) {
      const started = performance.now();
      redactSecrets(cmd);
      expect(performance.now() - started, cmd.slice(0, 12)).toBeLessThan(250);
    }

    // the whole scan, with such a line on an agent, an MCP server and a process nobody lists
    const { monitor } = setup([
      agent(100, REPO, { cmd: `claude -p ${'a'.repeat(n)}` }),
      mcp(101, 100, { cmd: `node /x/node_modules/.bin/some-mcp-server ${'token'.repeat(n / 5)}` }),
      { pid: 300, ppid: 1, name: 'python3', cmd: `python3 -c ${'x-'.repeat(n / 2)}`, etime: '10:00' },
    ]);
    const started = performance.now();
    const list = await monitor.scan(1_000);
    expect(performance.now() - started).toBeLessThan(500);
    expect(list.map((p) => p.pid).sort()).toEqual([100, 101]);
  });

  it('redacts before it shortens: a secret cut at the edge of the line stays hidden', async () => {
    // Shortened first, a URL lost its "@" and a token its length, and neither was recognized any
    // more: the visible part of the password or token was shown (external audit, 21.11.2026)
    const { monitor } = setup([
      mcp(70, 69, { cmd: `node mcp-proxy ${'a'.repeat(60)} https://u:hunter2hunter2hunter2@host.example/x` }),
      agent(80, REPO, { cmd: `claude ${'x'.repeat(60)} ghp_abcdefghijklmnopqrstuvwxyz` }),
    ]);
    const list = await monitor.scan(Date.now());
    const text = list.map((p) => p.cmd).join('\n');
    expect(list).toHaveLength(2);
    expect(text).not.toMatch(/hunter|ghp_a/);
  });
});

describe('working directories', () => {
  it('shortens the home directory to ~, but not a directory whose name only starts like it', async () => {
    // /Users/x-backup/repo was shown as ~-backup/repo (external audit, 21.11.2026)
    const home = os.homedir();
    const { monitor } = setup([agent(100, `${home}/projects/app`), agent(200, `${home}-backup/repo`), agent(300, home)]);
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p.cwd]));
    expect(byPid.get(100)).toBe('~/projects/app');
    expect(byPid.get(200)).toBe(`${home}-backup/repo`);
    expect(byPid.get(300)).toBe('~');
  });
});

describe('memory', () => {
  // RSS was wrong both ways: an idle MCP server showed 12 KB RSS and 24 MB footprint, a Claude
  // session 486 MB RSS and 263 MB footprint (measured on 20.11.2026)
  function withReader(reader: (pids: number[]) => Promise<Map<number, number>>) {
    const procs = [agent(100, REPO, { cpu: 1, rssKb: 486_000 }), mcp(101, 100, { rssKb: 12 })];
    const calls: number[][] = [];
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => procs,
      memoryReader: async (pids) => {
        calls.push([...pids].sort((a, b) => a - b));
        return reader(pids);
      },
    });
    return { monitor, calls, procs };
  }
  const MB = 1024 * 1024;

  it('shows the physical footprint, and RSS marked as approximate where it cannot be read', async () => {
    const { monitor } = withReader(async () => new Map([[100, 263 * MB]]));
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p]));
    expect(byPid.get(100)).toMatchObject({ memoryMb: 263, memorySource: 'footprint' });
    // 12 KB RSS: shown, but not as the footprint
    expect(byPid.get(101)).toMatchObject({ memoryMb: 0, memorySource: 'rss' });
  });

  it('reads the footprint at most every 15 seconds, and forgets the value of a PID that left the list', async () => {
    const { monitor, calls, procs } = withReader(async (pids) => new Map(pids.map((pid) => [pid, 50 * MB])));
    const t0 = 1_000_000;
    await monitor.scan(t0);
    await monitor.scan(t0 + 2_000);
    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 1);
    expect(calls).toEqual([[100, 101]]);

    // 101 exits and a new MCP server gets the same PID before the next read
    const gone = procs.splice(1, 1)[0];
    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 500);
    procs.push({ ...gone, cmd: 'node /x/node_modules/.bin/mcp-server-time', rssKb: 20_480, etime: '00:01' });
    const reused = (await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 200)).find((p) => p.pid === 101)!;
    expect(reused).toMatchObject({ memoryMb: 20, memorySource: 'rss' });

    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS);
    expect(calls).toHaveLength(2);
  });

  it('falls back to RSS for good when the system has no footprint tool, and for one read on any other failure', async () => {
    let failure: NodeJS.ErrnoException | null = Object.assign(new Error('spawn footprint ENOENT'), { code: 'ENOENT' });
    const { monitor, calls } = withReader(async () => {
      if (failure) throw failure;
      return new Map([[100, 263 * MB]]);
    });
    const [first] = await monitor.scan(1_000);
    expect(first.memorySource).toBe('rss');
    failure = null;
    await monitor.scan(1_000 + MEMORY_READ_INTERVAL_MS);
    expect(calls).toHaveLength(1);

    const flaky = withReader(async () => {
      if (failure) throw failure;
      return new Map([[100, 263 * MB]]);
    });
    failure = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect((await flaky.monitor.scan(1_000))[0].memorySource).toBe('rss');
    failure = null;
    expect((await flaky.monitor.scan(1_000 + MEMORY_READ_INTERVAL_MS))[0]).toMatchObject({ memorySource: 'footprint', memoryMb: 263 });
  });

  it('never inspects the memory of a PID from a custom process table', async () => {
    // tests and the demo make PIDs up; on a real machine they can name anyone's process
    const monitor = new ProcessMonitor({ rootDir: REPO, selfPid: 999_999, processLister: async () => [agent(100, REPO, { rssKb: 2048 })] });
    const [proc] = await monitor.scan(1_000);
    expect(proc).toMatchObject({ memoryMb: 2, memorySource: 'rss' });
  });
});

describe('footprint output', () => {
  it('takes phys_footprint per requested PID from the JSON, whatever the processes are called', () => {
    const data = {
      unit: 'byte',
      'bytes per unit': 1,
      processes: [
        { name: 'claude', pid: 41926, footprint: 275152896, auxiliary: { phys_footprint: 277094400 } },
        // a name that imitates the text output of another PID changes nothing in JSON
        { name: 'x [41926]: 64-bit    Footprint: 1 B\n    phys_footprint: 1 B', pid: 512, footprint: 25165824, auxiliary: {} },
        { name: 'not asked for', pid: 9, footprint: 1, auxiliary: { phys_footprint: 1 } },
      ],
    };
    expect(parseFootprintJson(data, [41926, 512])).toEqual(
      new Map([
        [41926, 277094400],
        [512, 25165824],
      ]),
    );
  });

  it('reads nothing from output that is not what it expects', () => {
    for (const data of [null, 'text', { processes: 'x' }, { processes: [{ pid: '41926', footprint: 1 }] }, { processes: [{ pid: 7, footprint: -1 }] }]) {
      expect(parseFootprintJson(data, [41926, 7]).size, JSON.stringify(data)).toBe(0);
    }
  });
});

describe('ps output', () => {
  it('keeps every column in place when a program path contains spaces', () => {
    const main = [
      '  PID  PPID  PGID    RSS  %CPU %MEM     ELAPSED      TIME ARGS',
      '41926 41925 41925 377772   1.5  2.1    20:39:41   4:09.88 /Users/me/Library/Application Support/Claude/claude-code/claude --model x',
      '  512     1   512   1024   0.0  0.0 01-02:03:04   0:00.45 node /x/node_modules/.bin/mcp-server-git',
    ].join('\n');
    const comm = ['  PID COMM', '41926 /Users/me/Library/Application Support/Claude/claude-code/claude', '  512 node'].join('\n');
    expect(parsePsOutput(main, comm)).toEqual([
      {
        pid: 41926,
        ppid: 41925,
        pgid: 41925,
        rssKb: 377772,
        cpu: 1.5,
        memory: 2.1,
        etime: '20:39:41',
        cpuTimeSec: 249.88,
        name: '/Users/me/Library/Application Support/Claude/claude-code/claude',
        cmd: '/Users/me/Library/Application Support/Claude/claude-code/claude --model x',
      },
      expect.objectContaining({ pid: 512, name: 'node', cpuTimeSec: 0.45, etime: '01-02:03:04', cmd: 'node /x/node_modules/.bin/mcp-server-git' }),
    ]);
  });
});

describe('CPU time from ps', () => {
  it('reads the macOS and the Linux format, and nothing else', () => {
    expect(parseCpuTime('0:00.45')).toBeCloseTo(0.45);
    expect(parseCpuTime('240:42.31')).toBeCloseTo(240 * 60 + 42.31);
    expect(parseCpuTime('00:01:23')).toBe(83);
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseCpuTime('')).toBeUndefined();
    expect(parseCpuTime('-')).toBeUndefined();
    expect(parseCpuTime('abc')).toBeUndefined();
  });
});

describe('working directory resolution', () => {
  it('parses lsof field output and skips the root directory', () => {
    const map = parseLsofCwdOutput('p100\nfcwd\nn/work/repo\np200\nfcwd\nn/\np300\nfcwd\nn/work/with space\n');
    expect(Array.from(map.entries())).toEqual([
      [100, '/work/repo'],
      [300, '/work/with space'],
    ]);
  });

  it('reads /proc/<pid>/cwd on Linux without spawning lsof', async () => {
    const asked: string[] = [];
    const map = await resolveProcessCwds(
      [100, 200, 300],
      (target) => {
        asked.push(target);
        if (target === '/proc/200/cwd') throw new Error('EACCES');
        return target === '/proc/100/cwd' ? '/work/repo' : '/';
      },
      'linux',
    );
    expect(asked).toEqual(['/proc/100/cwd', '/proc/200/cwd', '/proc/300/cwd']);
    expect(Array.from(map.entries())).toEqual([[100, '/work/repo']]);
  });

  it('returns an empty map for an empty PID list', async () => {
    expect((await resolveProcessCwds([])).size).toBe(0);
  });
});
