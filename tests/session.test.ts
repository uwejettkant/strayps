import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot } from '../src/core/session.js';
import { cleanupTmpDirs, commitAll, createHarness, exists, initGitRepo, read, writeFiles } from './helpers/harness.js';

afterEach(() => {
  cleanupTmpDirs();
  vi.useRealTimers();
});

const OTHER = '/work/other-repo';

describe('WatchdogSession', () => {
  it('gives every front end one merged, newest-first view of file, process and session events', async () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', rssKb: 100_000, cpuTimeSec: 1.5 }],
    });
    h.watcher.createCheckpoint();

    writeFiles(h.dir, { 'a.ts': 'changed\n' });
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    await h.monitor.scan();
    h.session.addEvent({ type: 'watch-error', message: 'from the session', severity: 'warn' });

    const snapshot = h.session.getSnapshot();
    expect(snapshot.rootDir).toBe(h.dir);
    expect(snapshot.modifiedFiles).toEqual(['a.ts']);
    expect(snapshot.limitState).toBe('ok');
    expect(snapshot.processes.map((p) => p.pid)).toEqual([300]);

    const types = snapshot.events.map((e) => e.type);
    expect(types).toContain('checkpoint-created');
    expect(types).toContain('file-edit');
    expect(types).toContain('process-alert');
    expect(types).toContain('watch-error');
    const stamps = snapshot.events.map((e) => e.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));

    expect(h.session.getCounters()).toMatchObject({ 'file-edit': 1, 'process-alert': 1, 'watch-error': 1 });
  });

  it('reflects the hard-stop state as soon as edited limits make the current file count too many', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 16; i++) files[`f${i}.ts`] = 'x\n';
    const h = createHarness({ files });
    h.watcher.createCheckpoint();
    for (let i = 0; i < 16; i++) h.watcher.handleFileSystemEvent('change', `f${i}.ts`);

    expect(h.session.getSnapshot().limitState).toBe('warn');
    writeFiles(h.dir, { '.agentguard.json': JSON.stringify({ limits: { maxFilesWarn: 10, maxFilesHardStop: 12 } }) });
    h.session.reloadConfig();
    expect(h.session.getSnapshot().limitState).toBe('hard-stop');
  });

  it('counts the limits since the last commit and shows both lists to every front end', () => {
    const h = createHarness({ files: { 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' }, config: { limits: { maxFilesWarn: 2, maxFilesHardStop: 3 } } });
    initGitRepo(h.dir);
    commitAll(h.dir);
    h.watcher.createCheckpoint();
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      writeFiles(h.dir, { [name]: 'changed\n' });
      h.watcher.handleFileSystemEvent('change', name);
    }
    expect(h.session.getSnapshot()).toMatchObject({ limitState: 'hard-stop', countsSinceCommit: true });

    commitAll(h.dir, 'work');
    h.watcher.checkCommits();
    const snapshot = h.session.getSnapshot();
    expect(snapshot.uncommittedFiles).toEqual([]);
    expect(snapshot.modifiedFiles.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(snapshot.limitState).toBe('ok');
    expect(snapshot.events[0]).toMatchObject({ type: 'commit-detected', severity: 'info' });
  });

  it('terminates only monitored processes and says why it refuses', async () => {
    const h = createHarness({
      procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', cpuTimeSec: 1.5 }],
    });
    await h.monitor.scan();

    expect(h.session.killProcess(4242)).toMatchObject({ ok: false, error: expect.stringContaining('not a monitored') });
    expect(h.session.killProcess(-1)).toMatchObject({ ok: false, error: 'Invalid PID' });
    expect(h.session.killProcess(1.5)).toMatchObject({ ok: false, error: 'Invalid PID' });
    expect(h.kills).toEqual([]);

    expect(h.session.killProcess(300)).toEqual({ ok: true, pid: 300 });
    expect(h.kills).toEqual([{ pid: 300, signal: 'SIGTERM' }]);
    expect(h.session.getSnapshot().events[0]).toMatchObject({
      type: 'process-killed',
      message: expect.stringContaining('Sent SIGTERM to PID 300'),
    });
  });

  it('ends an agent session together with the processes it started, exactly the ones confirmed', async () => {
    // Ending only the agent left its MCP servers behind as orphans, to be found and ended one by one
    const h = createHarness({
      procs: [
        { pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', cpuTimeSec: 1.5 },
        { pid: 401, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '03-00:00:00' },
        { pid: 402, ppid: 400, name: 'codex', cmd: 'codex exec', cwd: OTHER, etime: '01:00:00' },
        { pid: 403, ppid: 402, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-fetch', etime: '01:00:00' },
        { pid: 404, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-time', etime: '01:00:00' },
        // another session and an editor's MCP server stay untouched
        { pid: 500, name: 'claude', cmd: 'claude', cwd: '/work/third-repo', etime: '01:00:00' },
        { pid: 501, ppid: 500, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '01:00:00' },
        { pid: 600, ppid: 1, pgid: 600, name: 'Code', cmd: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
        { pid: 601, ppid: 600, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '01:00:00' },
      ],
    });
    await h.monitor.scan();

    const plan = h.session.getKillPlan(400)!;
    expect(plan.target.pid).toBe(400);
    // agents first: they are what a person most needs to see before saying yes
    expect(plan.alsoEnds[0].pid).toBe(402);
    expect(plan.alsoEnds.map((p) => p.pid).sort()).toEqual([401, 402, 403, 404]);
    // a nested agent's plan leaves out its parent and its siblings
    expect(h.session.getKillPlan(402)!.alsoEnds.map((p) => p.pid)).toEqual([403]);
    // a process that is not an agent ends alone
    expect(h.session.getKillPlan(401)!.alsoEnds).toEqual([]);
    expect(h.session.getKillPlan(4242)).toBeNull();
    expect(h.session.getSnapshot().sessionMembers).toEqual({
      400: plan.alsoEnds.map((p) => p.pid),
      402: [403],
      500: [501],
    });

    const shown = (pid: number) => ({ pid, firstSeenAt: plan.alsoEnds.find((p) => p.pid === pid)?.firstSeenAt ?? 0 });
    // 501 and 601 are not part of this session; 404 was not confirmed; 999 is gone
    const result = h.session.killProcess(400, {
      also: [shown(401), shown(402), shown(403), { pid: 501, firstSeenAt: 0 }, { pid: 601, firstSeenAt: 0 }, { pid: 999, firstSeenAt: 0 }],
    });
    expect(result).toMatchObject({ ok: true, pid: 400, targetSignalled: true, leftRunning: [404], notFound: [501, 601, 999], failed: [] });
    expect(result.ok && [...(result.alsoEnded ?? [])].sort()).toEqual([401, 402, 403]);
    expect(h.kills.map((k) => k.pid).sort()).toEqual([400, 401, 402, 403]);
    expect(h.kills[0]).toEqual({ pid: 400, signal: 'SIGTERM' });
    expect(h.session.getSnapshot().events[0]).toMatchObject({
      type: 'process-alert',
      severity: 'warn',
      message: 'PID 404 belongs to the session of PID 400 but was not in the confirmation, so it keeps running',
    });
  });

  it('takes an agent it started only when that agent works in the same directory, never in home or /', async () => {
    // An editor that starts MCP servers and is not a known host counts as an agent; the sessions
    // in its terminal, in other repositories, must not end with it
    const home = os.homedir();
    const h = createHarness({
      procs: [
        { pid: 700, name: 'nvim', cmd: 'nvim', cwd: '/work', etime: '05:00:00' },
        { pid: 701, ppid: 700, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-hub', etime: '05:00:00' },
        // a repository below the target's directory is still another session
        { pid: 702, ppid: 700, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '04:00:00' },
        { pid: 703, ppid: 702, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '04:00:00' },
        // no working directory: not known to be the same directory either
        { pid: 704, ppid: 700, name: 'codex', cmd: 'codex', etime: '04:00:00' },
        // the same directory: part of the session
        { pid: 705, ppid: 700, name: 'codex', cmd: 'codex exec', cwd: '/work', etime: '04:00:00' },
        // started from the home directory, both of them: home is not a shared repository
        { pid: 800, name: 'nvim', cmd: 'nvim', cwd: home, etime: '05:00:00' },
        { pid: 801, ppid: 800, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-hub', etime: '05:00:00' },
        { pid: 802, ppid: 800, name: 'claude', cmd: 'claude', cwd: home, etime: '04:00:00' },
        { pid: 803, ppid: 800, name: 'claude', cmd: 'claude', cwd: `${home}/work/other`, etime: '04:00:00' },
      ],
    });
    await h.monitor.scan();
    expect(h.session.getKillPlan(700)!.alsoEnds.map((p) => p.pid)).toEqual([705, 701]);
    expect(h.session.getKillPlan(800)!.alsoEnds.map((p) => p.pid)).toEqual([801]);
  });

  it('ends nothing of a session whose agent is gone or whose PIDs were reused since the question', async () => {
    const h = createHarness({
      procs: [
        { pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00' },
        { pid: 401, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '03-00:00:00' },
      ],
    });
    const t0 = Date.now();
    await h.monitor.scan(t0);
    const shown = h.session.getKillPlan(400)!.alsoEnds.map((p) => ({ pid: p.pid, firstSeenAt: p.firstSeenAt }));

    // 401 exits and a different process gets the same PID while the question is open
    h.procs.splice(1, 1);
    await h.monitor.scan(t0 + 2000);
    h.procs.push({ pid: 401, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-time', etime: '00:01' });
    await h.monitor.scan(t0 + 4000);
    expect(h.session.killProcess(400, { also: shown })).toMatchObject({ ok: true, alsoEnded: [], leftRunning: [401] });
    expect(h.kills.map((k) => k.pid)).toEqual([400]);

    // the agent itself is gone by the time the answer comes
    const g = createHarness({
      procs: [
        { pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00' },
        { pid: 401, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '03-00:00:00' },
      ],
    });
    await g.monitor.scan();
    const confirmed = g.session.getKillPlan(400)!.alsoEnds.map((p) => ({ pid: p.pid, firstSeenAt: p.firstSeenAt }));
    g.procs.splice(0, 1);
    g.procs[0].ppid = 1;
    await g.monitor.scan();
    expect(g.session.killProcess(400, { also: confirmed })).toEqual({
      ok: false,
      pid: 400,
      error: 'PID 400 is no longer running, so nothing was ended; the processes it started are listed on their own now',
    });
    expect(g.kills).toEqual([]);
  });

  it('ends nothing when the named PID belongs to a different process than the one shown', async () => {
    const h = createHarness({ procs: [{ pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00' }] });
    const t0 = Date.now();
    await h.monitor.scan(t0);
    const shown = h.session.getKillPlan(400)!.target.firstSeenAt;
    // within one scan interval the PID goes to a new process: it is younger than the old one was
    h.procs[0] = { pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '00:01' };
    await h.monitor.scan(t0 + 2000);
    expect(h.session.killProcess(400, { firstSeenAt: shown })).toEqual({
      ok: false,
      pid: 400,
      error: 'PID 400 now belongs to a different process than the one shown, so nothing was ended',
    });
    expect(h.kills).toEqual([]);
  });

  it('ends only the named process when no other PIDs are confirmed', async () => {
    const h = createHarness({
      procs: [
        { pid: 400, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', cpuTimeSec: 1.5 },
        { pid: 401, ppid: 400, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git', etime: '03-00:00:00' },
      ],
    });
    await h.monitor.scan();
    expect(h.session.killProcess(400)).toEqual({ ok: true, pid: 400 });
    expect(h.kills).toEqual([{ pid: 400, signal: 'SIGTERM' }]);
  });

  it('reports stale and frozen processes, but never terminates one because of its status', async () => {
    const h = createHarness({
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', cwd: '<repo>', cpu: 2, etime: '08:00:00' },
        { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', cpuTimeSec: 1.5 },
        { pid: 301, ppid: 1, pgid: 290, name: 'node', cmd: 'node some-mcp-server', cpu: 0, etime: '01:00:00' },
      ],
    });
    h.procs[0].cwd = h.dir;
    await h.monitor.scan();

    const byPid = new Map(h.session.getSnapshot().processes.map((p) => [p.pid, p]));
    expect(byPid.get(300)?.status).toBe('STALE');
    expect(byPid.get(301)?.status).toBe('FROZEN');
    // no bulk cleanup: a stale verdict has been wrong about sessions still in use
    expect('killStale' in h.session).toBe(false);
    expect(h.session.getPauseTargets().map((p) => p.pid)).toEqual([100]);
    expect(h.kills).toEqual([]);
  });

  it('pause holds the agents of the watched repository, touches no file and logs it; resume continues them', async () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', cpu: 5, etime: '10:00' },
        { pid: 101, ppid: 100, name: 'node', cmd: 'node some-mcp-server', cwd: '/', cpu: 0, etime: '10:00' },
        { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, cpu: 9, etime: '03-00:00:00' },
      ],
    });
    h.procs[0].cwd = h.dir;
    h.watcher.createCheckpoint();
    await h.monitor.scan();
    writeFiles(h.dir, { 'a.ts': 'agent work\n' });
    h.watcher.handleFileSystemEvent('change', 'a.ts');

    expect(h.session.getPauseTargets().map((p) => p.pid).sort()).toEqual([100, 101]);
    expect(h.session.pause().pids.sort()).toEqual([100, 101]);
    expect(h.kills.map((k) => k.signal)).toEqual(['SIGSTOP', 'SIGSTOP']);
    // nothing is rolled back, nothing leaves the list
    expect(read(h.dir, 'a.ts')).toBe('agent work\n');
    expect(h.session.getSnapshot().processes.filter((p) => p.paused).map((p) => p.pid).sort()).toEqual([100, 101]);
    expect(h.session.getSnapshot().events[0]).toMatchObject({ type: 'process-paused', severity: 'warn' });

    expect(h.session.resume().pids.sort()).toEqual([100, 101]);
    expect(h.kills.slice(2).map((k) => k.signal)).toEqual(['SIGCONT', 'SIGCONT']);
    expect(h.session.getSnapshot().events[0].type).toBe('process-resumed');
    expect(h.session.resume().pids).toEqual([]);
  });

  it('re-arms the circuit breaker for a file once it has been rolled back', () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      watcher: { keepDiscarded: false },
      config: { limits: { maxFilesWarn: 15, maxFilesHardStop: 40, maxEditsPerFilePerMinute: 2, mcpSilenceTimeoutSec: 45 } },
    });
    h.watcher.createCheckpoint();
    for (let i = 1; i <= 3; i++) {
      writeFiles(h.dir, { 'a.ts': `edit ${i}\n` });
      h.watcher.handleFileSystemEvent('change', 'a.ts');
    }
    expect(h.session.getSnapshot().trippedFiles).toEqual(['a.ts']);
    expect(read(h.dir, 'a.ts')).toBe('edit 3\n');

    expect(h.session.rollbackFile('a.ts')).toBe(true);
    expect(h.session.getSnapshot().trippedFiles).toEqual([]);
    expect(read(h.dir, 'a.ts')).toBe('a\n');
    expect(h.session.rollbackFile('../outside.txt')).toBe(false);
  });

  it('coalesces a burst of changes into a few updates', async () => {
    vi.useFakeTimers();
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`src/f${i}.ts`] = 'x\n';
    const h = createHarness({ files, config: { limits: { maxFilesWarn: 1000, maxFilesHardStop: 2000 } } });
    h.watcher.createCheckpoint();
    const updates: StatusSnapshot[] = [];
    const events: string[] = [];
    h.session.on('update', (snapshot: StatusSnapshot) => updates.push(snapshot));
    h.session.on('event', (event: { type: string }) => events.push(event.type));

    for (let i = 0; i < 300; i++) h.watcher.handleFileSystemEvent('change', `src/f${i}.ts`);
    expect(events.filter((t) => t === 'file-edit')).toHaveLength(300);
    expect(updates).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(updates).toHaveLength(1);
    expect(updates[0].modifiedFiles).toHaveLength(300);

    await vi.advanceTimersByTimeAsync(1000);
    expect(updates).toHaveLength(1);
  });

  it('reports a failing process scan once, not every two seconds', async () => {
    let fail = true;
    const h = createHarness();
    const failing = new (await import('../src/core/process-monitor.js')).ProcessMonitor({
      rootDir: h.dir,
      selfPid: 999_999,
      processLister: async () => {
        if (fail) throw new Error('ps exploded');
        return [];
      },
    });
    const { WatchdogSession } = await import('../src/core/session.js');
    const session = new WatchdogSession({
      rootDir: h.dir,
      configManager: h.configManager,
      watcher: h.watcher,
      processMonitor: failing,
    });

    await failing.scan();
    await failing.scan();
    await failing.scan();
    const errors = () => session.getSnapshot().events.filter((e) => e.type === 'watch-error');
    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toContain('ps exploded');

    fail = false;
    await failing.scan();
    fail = true;
    await failing.scan();
    expect(errors()).toHaveLength(2);
  });

  it('stops listening after dispose', () => {
    const h = createHarness({ files: { 'a.ts': 'a\n' } });
    h.watcher.createCheckpoint();
    const onEvent = vi.fn();
    h.session.on('event', onEvent);
    h.session.dispose();

    h.watcher.handleFileSystemEvent('change', 'a.ts');
    expect(onEvent).not.toHaveBeenCalled();
    expect(h.watcher.listenerCount('activity')).toBe(0);
    expect(h.monitor.listenerCount('scan-complete')).toBe(0);
  });
});
