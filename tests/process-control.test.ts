import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseLsofCwdOutput,
  ProcessMonitor,
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

function setup(procs: RawProcessInfo[], options: { killGraceMs?: number; selfPid?: number } = {}): Setup {
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
    monitor.recordFileActivity(t0);
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
    monitor.recordFileActivity(t0);
    await monitor.scan(t0);
    await monitor.scan(t0 + 46_000);
    const list = await monitor.scan(t0 + 30 * 60_000);

    expect(list[0].status).toBe('IDLE');
    expect(list[0].inWatchedRepo).toBe(true);
    expect(list[0].pauseTarget).toBe(true);
    expect(onFrozen).not.toHaveBeenCalled();
  });

  it('flags an old session in another repository as STALE and names what it is attached to', async () => {
    const { monitor } = setup([
      { pid: 500, ppid: 1, name: 'Code', cmd: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
      { pid: 501, ppid: 500, name: 'Code Helper (Plugin)', cmd: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
      agent(502, OTHER, { ppid: 501, etime: '02-15:40:05' }),
      mcp(503, 502, { cwd: OTHER, etime: '02-15:40:01' }),
    ]);

    const list = await monitor.scan(1_000);
    const session = list.find((p) => p.pid === 502)!;
    expect(session.status).toBe('STALE');
    expect(session.host).toBe('VS Code');
    expect(session.reason).toBe('Session in /work/other-repo, running for 2d 15h, attached to VS Code');
    // an observation, not a verdict: age alone has been wrong about sessions still in use
    expect(session.reason).not.toMatch(/safe to kill/i);
    expect(session.inWatchedRepo).toBe(false);
    expect(session.pauseTarget).toBe(false);
    // the editor itself is not an agent process
    expect(list.map((p) => p.pid).sort()).toEqual([502, 503]);
  });

  it('does not call a quiet process frozen while its parent is alive, however long it is quiet', async () => {
    // Audit D-02: a resting watch server, a browser and a young session in another repository
    // were "frozen" after 45 quiet seconds. Quiet is not frozen.
    const { monitor } = setup([
      { pid: 50, name: 'zsh', cmd: '-zsh', cwd: REPO, cpu: 0, etime: '02:00:00' },
      { pid: 51, ppid: 50, name: 'node', cmd: 'node node_modules/.bin/tsx watch src/server.ts', cwd: REPO, cpu: 0, etime: '30:00' },
      { pid: 60, name: 'zsh', cmd: '-zsh', cwd: OTHER, cpu: 0, etime: '02:00:00' },
      { pid: 61, ppid: 60, name: 'Chromium', cmd: 'Chromium --headless --remote-debugging-port=9222', cpu: 0, etime: '20:00' },
      agent(62, OTHER, { ppid: 60, etime: '15:00' }),
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
      { pid: 80, ppid: 1, pgid: 80, name: 'Chromium', cmd: '/Applications/Chromium.app/Contents/MacOS/Chromium', cpu: 0, etime: '05:00:00' },
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
        { pid: 20, ppid: 10, name: 'node', cmd: `node ${REPO}/node_modules/.bin/tsx src/cli.ts watch` },
        { pid: 30, ppid: 20, name: 'node', cmd: 'node src/cli.ts watch' },
        { pid: 40, ppid: 1, name: 'node', cmd: 'node ./node_modules/.bin/tsx watch server.ts', cwd: REPO },
      ],
      { selfPid: 30 },
    );

    const list = await monitor.scan(1_000);
    expect(list.map((p) => p.pid)).toEqual([40]);
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

  // Known gaps: the behavior is not decided yet (AGENTS.md, section 6)
  it.todo('does not call an other-repo session stale while it is demonstrably in use');
  it.todo('does not flag an idle dev server (tsx watch, nodemon, ...) as frozen after 45 seconds');
  it.todo('measures CPU activity from CPU time deltas instead of ps %cpu (lifetime average on Linux)');
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
    monitor.recordFileActivity(t0);
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
    // vibe-check.js only contains the name
    expect(list.find((p) => p.pid === 92)?.category).toBe('node');
  });

  it('does not take a program for an agent because its name merely contains one', async () => {
    const { monitor } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 101, ppid: 100, name: 'node', cmd: 'node /x/node_modules/.bin/codex-mcp-server', cwd: REPO },
      { pid: 102, ppid: 1, name: 'node', cmd: `node ${REPO}/scripts/aider-stats.js`, cwd: REPO },
    ]);

    const list = await monitor.scan(1_000);
    expect(list.find((p) => p.pid === 101)?.category).toBe('mcp');
    expect(list.find((p) => p.pid === 102)?.category).toBe('node');
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

    expect(monitor.getPauseTargets().map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 101]);
    expect(monitor.pauseTargets().sort((a, b) => a - b)).toEqual([100, 101]);
    // held, not terminated: nothing leaves the list, nothing is killed
    expect(kills.map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGSTOP', '101:SIGSTOP']);
    expect(monitor.getProcesses()).toHaveLength(6);
    expect(monitor.getPausedPids().sort((a, b) => a - b)).toEqual([100, 101]);
    // pausing again holds nothing twice
    expect(monitor.pauseTargets()).toEqual([]);

    expect(monitor.resumePaused().sort((a, b) => a - b)).toEqual([100, 101]);
    expect(kills.slice(2).map((k) => `${k.pid}:${k.signal}`).sort()).toEqual(['100:SIGCONT', '101:SIGCONT']);
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
