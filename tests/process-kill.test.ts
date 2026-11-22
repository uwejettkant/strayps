import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMonitor } from '../src/core/process-monitor.js';
import { MEMORY_READ_INTERVAL_MS } from '../src/core/processes/memory.js';
import { takeBlockedKills } from './helpers/kill-guard.js';
import { agent, mcp, OTHER, REPO, setup } from './helpers/processes.js';

afterEach(() => {
  vi.useRealTimers();
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

  it('continues only the held process it ends, never what pause held below it', async () => {
    // Continuing the held children would let work run again that the person had stopped, by a
    // kill they confirmed for another process (maintainer decision, 22.11.2026). They stay held and
    // listed until resume, or until they are ended themselves.
    const { monitor, kills } = setup([
      agent(100, REPO, { cpu: 1 }),
      { pid: 102, ppid: 100, name: 'node', cmd: 'node node_modules/.bin/vite', cwd: REPO, etime: '02:00' },
      { pid: 103, ppid: 102, name: 'node', cmd: 'node vite-worker.js', cwd: REPO, etime: '02:00' },
      { pid: 104, ppid: 102, name: 'bash', cmd: 'bash -c esbuild', cwd: REPO, etime: '00:01' },
    ]);
    await monitor.scan(1_000);
    expect(monitor.pauseTargets(monitor.getPauseTargets()).pids.sort()).toEqual([100, 102, 103, 104]);
    kills.length = 0;

    expect(monitor.killProcess(102)).toBe(true);
    expect(kills.map((k) => `${k.pid}:${k.signal}`)).toEqual(['102:SIGTERM', '102:SIGCONT']);
    expect(monitor.getPausedPids().sort()).toEqual([100, 103, 104]);
    await monitor.scan(3_000);
    expect(monitor.getProcesses().filter((p) => p.paused).map((p) => p.pid).sort()).toEqual([100, 103, 104]);
    monitor.resumePaused();
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
