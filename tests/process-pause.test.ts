import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMonitor } from '../src/core/process-monitor.js';
import type { RawProcessInfo } from '../src/core/processes/types.js';
import { agent, mcp, OTHER, REPO, setup, VSCODE_HELPER } from './helpers/processes.js';

afterEach(() => {
  vi.useRealTimers();
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
    expect(outcome).toEqual({ pids: [100, 101, 110, 111], gone: [], notAsked: [], alsoHeld: [110, 111], belowEnding: [] });
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

    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [], belowEnding: [] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '100:SIGSTOP']);
    monitor.resumePaused();
  });

  it('never offers or holds a process being ended, also after a scan within its grace period', async () => {
    // A scan in the grace period no longer listed it, and pause offered it as an unlisted process of
    // its agent: held, it could not clean up, and the escalation ended it with SIGKILL while it was
    // stopped (safety review, 22.11.2026)
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
    ]);
    await monitor.scan(1_000);
    expect(monitor.killProcess(102)).toBe(true);
    await monitor.scan(3_000);

    const asked = monitor.getPauseTargets();
    expect(asked.map((t) => t.pid)).toEqual([100]);
    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [], belowEnding: [] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '100:SIGSTOP']);
    // hold() refuses it too, whatever offers it: every SIGSTOP goes through there
    const internals = monitor as unknown as { hold(pid: number, elapsedSec: number, at: number): boolean };
    expect(internals.hold(102, 120, 0)).toBe(false);
    expect(kills.filter((k) => k.pid === 102).map((k) => k.signal)).toEqual(['SIGTERM']);
    monitor.resumePaused();
  });

  it('does not name an agent being ended as one that keeps running', async () => {
    // A subagent in its grace period was reported as "started after the question and keeps
    // running: type pause again", which the next pause did not offer either (safety review, 22.11.2026)
    const { monitor, kills } = setup([agent(100, REPO, { cpu: 1 }), agent(200, REPO, { ppid: 100, cpu: 1 })]);
    await monitor.scan(1_000);
    expect(monitor.killProcess(200)).toBe(true);
    await monitor.scan(3_000);

    const asked = monitor.getPauseTargets();
    expect(asked.map((t) => t.pid)).toEqual([100]);
    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [], belowEnding: [] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['200:SIGTERM', '100:SIGSTOP']);
    monitor.resumePaused();
  });

  // Held, what runs below a process being ended can keep it from exiting: its SIGTERM handler waits
  // for a stopped child, and after the grace period it is ended with SIGKILL instead (maintainer
  // decision, 22.11.2026). It is left out up to the nearest agent, for the grace period, and named.
  it('leaves what runs below a process being ended to it, listed or not, and names it', async () => {
    const { monitor, kills, procs, alive } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
      // its worker, listed, and a shell it just started, not listed yet
      { pid: 103, ppid: 102, name: 'node', cmd: 'node vite-worker.js', cwd: REPO, etime: '02:00' },
      { pid: 104, ppid: 102, name: 'bash', cmd: 'bash -c esbuild', cwd: REPO, etime: '00:01' },
    ]);
    await monitor.scan(1_000);
    expect(monitor.getPauseTargets().map((t) => t.pid).sort()).toEqual([100, 102, 103, 104]);
    expect(monitor.killProcess(102)).toBe(true);
    await monitor.scan(3_000);
    expect(monitor.getProcesses().find((p) => p.pid === 103)?.pauseTarget).toBe(false);

    const asked = monitor.getPauseTargets();
    expect(asked.map((t) => t.pid)).toEqual([100]);
    // started below the process being ended while the question is open
    procs.push({ pid: 105, ppid: 103, name: 'bash', cmd: 'bash -c sleep 1', cwd: REPO, etime: '00:00' });
    alive.add(105);
    expect(monitor.pauseTargets(asked)).toEqual({
      pids: [100],
      gone: [],
      notAsked: [],
      alsoHeld: [],
      belowEnding: [103, 104, 105],
    });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '100:SIGSTOP']);
    monitor.resumePaused();
  });

  it('leaves it out right after the kill too, before a scan has seen it', async () => {
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
      { pid: 103, ppid: 102, name: 'node', cmd: 'node vite-worker.js', cwd: REPO, etime: '02:00' },
      { pid: 104, ppid: 102, name: 'bash', cmd: 'bash -c esbuild', cwd: REPO, etime: '00:01' },
    ]);
    await monitor.scan(1_000);
    const before = monitor.getPauseTargets();
    expect(monitor.killProcess(102)).toBe(true);

    expect(monitor.getPauseTargets().map((t) => t.pid)).toEqual([100]);
    // confirmed before the kill: not held, and none of them "had exited": 102 is being ended, the
    // others run below it
    expect(monitor.pauseTargets(before)).toEqual({
      pids: [100],
      gone: [],
      notAsked: [],
      alsoHeld: [],
      belowEnding: [103, 104],
    });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '100:SIGSTOP']);
    monitor.resumePaused();
  });

  it('names each process below a process being ended once, also when a scan ran before the answer', async () => {
    // A listed process the scan no longer offers was counted as gone and as below a process being
    // ended at once (safety review, 22.11.2026; reachable through the library, where no question
    // keeps a kill from coming in between)
    const { monitor, alive } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 101, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/tsc --watch', cwd: REPO, etime: '02:00' },
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
      { pid: 103, ppid: 102, name: 'node', cmd: 'node vite-worker.js', cwd: REPO, etime: '02:00' },
      { pid: 104, ppid: 102, name: 'bash', cmd: 'bash -c esbuild', cwd: REPO, etime: '00:01' },
    ]);
    await monitor.scan(1_000);
    const before = monitor.getPauseTargets();
    expect(monitor.killProcess(102)).toBe(true);
    // and one that really exits: it is still reported as gone
    alive.delete(101);
    await monitor.scan(3_000);
    expect(monitor.pauseTargets(before)).toEqual({
      pids: [100],
      gone: [101],
      notAsked: [],
      alsoHeld: [],
      belowEnding: [103, 104],
    });
    monitor.resumePaused();
  });

  it('does not name a process that is being ended itself as one below a process being ended', async () => {
    // ending an agent with what it started: each of them got SIGTERM from the same person
    const { monitor } = setup([
      agent(100, REPO, { cpu: 1 }),
      agent(200, REPO, { ppid: 100, cpu: 1 }),
      { pid: 201, ppid: 200, name: 'node', cmd: 'node node_modules/.bin/tsc --watch', cwd: REPO, etime: '02:00' },
      { pid: 202, ppid: 201, name: 'node', cmd: 'node tsc-worker.js', cwd: REPO, etime: '02:00' },
    ]);
    await monitor.scan(1_000);
    expect(monitor.killProcess(200)).toBe(true);
    expect(monitor.killProcess(201)).toBe(true);
    await monitor.scan(3_000);
    expect(monitor.pauseTargets(monitor.getPauseTargets())).toEqual({
      pids: [100],
      gone: [],
      notAsked: [],
      alsoHeld: [],
      belowEnding: [202],
    });
    monitor.resumePaused();
  });

  it('leaves out what a subagent being ended runs, and still asks about agents below it', async () => {
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      agent(200, REPO, { ppid: 100, cpu: 1 }),
      { pid: 201, ppid: 200, name: 'node', cmd: 'node node_modules/.bin/tsc --watch', cwd: REPO, etime: '02:00' },
      // an agent the subagent started: a session of its own, asked about like every agent
      agent(210, REPO, { ppid: 200, name: 'codex', cmd: 'codex exec', cpu: 1 }),
    ]);
    await monitor.scan(1_000);
    expect(monitor.killProcess(200)).toBe(true);
    expect(monitor.getPauseTargets().map((t) => t.pid).sort()).toEqual([100, 210]);
    await monitor.scan(3_000);

    const asked = monitor.getPauseTargets();
    expect(asked.map((t) => t.pid).sort()).toEqual([100, 210]);
    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100, 210], gone: [], notAsked: [], alsoHeld: [], belowEnding: [201] });
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['200:SIGTERM', '100:SIGSTOP', '210:SIGSTOP']);
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
    expect(monitor.pauseTargets(asked)).toEqual({ pids: [100], gone: [], notAsked: [], alsoHeld: [], belowEnding: [] });
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
    expect(outcome).toEqual({ pids: [100, 110], gone: [], notAsked: [], alsoHeld: [110], belowEnding: [] });
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
