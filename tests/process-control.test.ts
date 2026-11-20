import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_READ_INTERVAL_MS,
  parseCpuTime,
  parseFootprintOutput,
  parsePsOutput,
  redactSecrets,
  parseLsofCwdOutput,
  ProcessMonitor,
  STALE_QUIET_SEC,
  type RawProcessInfo,
  resolveProcessCwds,
} from '../src/core/process-monitor.js';
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
  options: { killGraceMs?: number; selfPid?: number; processAge?: (pid: number) => number | undefined } = {},
): Setup {
  const kills: Setup['kills'] = [];
  const alive = new Set(procs.map((p) => p.pid));
  const table = [...procs];
  const monitor = new ProcessMonitor({
    rootDir: REPO,
    selfPid: options.selfPid ?? 999_999,
    killGraceMs: options.killGraceMs ?? 3000,
    processLister: async () => table.filter((p) => alive.has(p.pid)),
    processKiller: (pid, signal) => {
      kills.push({ pid, signal });
      return alive.has(pid);
    },
    processAlive: (pid) => alive.has(pid),
    processAge: options.processAge,
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

    // agent-leash has only just started watching: no evidence of inactivity yet
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

  it('does not count the processes agent-leash starts itself as work of the agent that started it', async () => {
    // agent-leash runs ps every 2 s; started from an agent's shell, that agent looked busy forever
    const { monitor, procs, alive } = setup(
      [
        agent(502, OTHER, { etime: '02-15:40:05', cpuTimeSec: 100 }),
        { pid: 600, ppid: 502, name: 'node', cmd: 'node agent-leash watch' },
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

  it('does not list the wrappers that launched the watchdog itself', async () => {
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
    // A known limit (README, "What agent-leash cannot see"): no memory of where a process came from
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

  it('never lists agent-leash itself, the wrappers that started it or what it runs', async () => {
    // started from an agent's shell: ending that agent's session must not end agent-leash
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
    expect(monitor.pauseTargets().sort((a, b) => a - b)).toEqual([100, 101, 102]);
    // held, not terminated: nothing leaves the list, nothing is killed
    expect(kills.map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGSTOP', '101:SIGSTOP', '102:SIGSTOP']);
    // the developer's dev server is not even listed: no agent started it
    expect(monitor.getProcesses().map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 101, 102, 200, 201, 501]);
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 101, 102]);
    // pausing again holds nothing twice
    expect(monitor.pauseTargets()).toEqual([]);

    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 101, 102]);
    expect(kills.slice(3).map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGCONT', '101:SIGCONT', '102:SIGCONT']);
    expect(monitor.getPausedPids()).toEqual([]);
  });

  it('never leaves an agent held when the watchdog stops', async () => {
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
      expect(proc.reason).toBe('Paused by agent-leash; resume continues it');
    }
    expect(onFrozen).not.toHaveBeenCalled();
  });

  it('the default killer cannot reach a real process from inside the test suite', async () => {
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => [agent(process.ppid, REPO)],
      // no processKiller: this is the real one
    });
    await monitor.scan(1_000);

    expect(monitor.killProcess(process.ppid)).toBe(false);
    expect(takeBlockedKills()).toEqual([{ pid: process.ppid, signal: 'SIGTERM' }]);
    monitor.stop();
  });
});

describe('ProcessMonitor pause and exit', () => {
  it('continues the processes it holds when agent-leash exits in any way, also by a crash', async () => {
    // The shutdown path resumed them, but a crash ended the process with them still stopped
    const { monitor, kills } = setup([agent(100, REPO, { cpu: 1 }), mcp(101, 100, { cwd: '/' })]);
    await monitor.scan(1_000);
    const before = process.listeners('exit');
    expect(monitor.pauseTargets().sort((a, b) => a - b)).toEqual([100, 101]);
    const added = process.listeners('exit').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    // what process.exit() from the crash handler, or an uncaught exception, runs
    (added[0] as () => void)();
    expect(kills.filter((k) => k.signal === 'SIGCONT').map((k) => k.pid).sort((a, b) => a - b)).toEqual([100, 101]);
    expect(monitor.getPausedPids()).toEqual([]);
    expect(process.listeners('exit').filter((listener) => !before.includes(listener))).toEqual([]);
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
  it('takes phys_footprint per process, skips the summary, and ignores PIDs it was not asked about', () => {
    const output = [
      '======================================================================',
      'claude [41926]: 64-bit    Footprint: 275152896 B (4096 bytes per page)',
      '======================================================================',
      '      Dirty         Clean   Reclaimable    Regions    Category',
      '   303104 B           0 B           0 B          4    MALLOC_SMALL',
      '    phys_footprint: 277094400 B',
      '    phys_footprint_peak: 335994880 B',
      '',
      'Code Helper (Plugin) [512]: 64-bit    Footprint: 25165824 B (16384 bytes per page)',
      '      Dirty         Clean   Reclaimable    Regions    Category',
      'Summary Footprint: 302318720 B',
      '    phys_footprint: 1 B',
    ].join('\n');
    expect(parseFootprintOutput(output)).toEqual(
      new Map([
        [41926, 277094400],
        [512, 25165824],
      ]),
    );
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
