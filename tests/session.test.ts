import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot } from '../src/core/session.js';
import { cleanupTmpDirs, createHarness, exists, read, writeFiles } from './helpers/harness.js';

afterEach(() => {
  cleanupTmpDirs();
  vi.useRealTimers();
});

const OTHER = '/work/other-repo';

describe('WatchdogSession', () => {
  it('gives every front end one merged, newest-first view of file, process and session events', async () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00', rssKb: 100_000 }],
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

  it('terminates only monitored processes and says why it refuses', async () => {
    const h = createHarness({
      procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00' }],
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

  it('reports stale and frozen processes, but never terminates one because of its status', async () => {
    const h = createHarness({
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', cwd: '<repo>', cpu: 2, etime: '08:00:00' },
        { pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, etime: '03-00:00:00' },
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
