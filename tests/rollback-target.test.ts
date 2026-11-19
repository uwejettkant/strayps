import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTmpDirs, createHarness, exists, type Harness, read, writeFiles } from './helpers/harness.js';

/**
 * Where a rollback goes back to. Decided on 17.11.2026: agent-leash never rolls back on its own
 * (in a long session that would throw away hours of good work); it raises an alarm, and `revert`
 * restores the version a file had before its latest series of changes, never further.
 */
afterEach(cleanupTmpDirs);

const MINUTE = 60_000;

/** The agent writes a file; the watcher learns about it at time `at`. */
function edit(h: Harness, file: string, content: string, at: number, action: 'add' | 'change' = 'change'): void {
  writeFiles(h.dir, { [file]: content });
  h.watcher.handleFileSystemEvent(action, file, at);
}

function eventsOf(h: Harness, type: string) {
  return h.session.getSnapshot().events.filter((e) => e.type === type);
}

describe('no automatic rollback', () => {
  it('raises an alarm for a protected file and leaves it as the agent wrote it', () => {
    const h = createHarness({ files: { 'docker-compose.yml': 'version: "3.8"\n' } });
    h.watcher.createCheckpoint();
    edit(h, 'docker-compose.yml', 'version: "tampered"\n', Date.now());

    expect(read(h.dir, 'docker-compose.yml')).toBe('version: "tampered"\n');
    const [alarm] = eventsOf(h, 'protected-file');
    expect(alarm).toMatchObject({ severity: 'critical', filePath: 'docker-compose.yml' });
    expect(alarm.rolledBack).not.toBe(true);
    expect(alarm.message).toBe(
      'Protected file changed: docker-compose.yml (revert restores the version before this change)',
    );
    expect(eventsOf(h, 'rollback')).toEqual([]);
  });

  it('raises an alarm when an agent thrashes on a file, and leaves the file alone', () => {
    const h = createHarness({ files: { 'src/a.ts': 'v0\n' } });
    h.watcher.createCheckpoint();
    const t0 = Date.now();
    for (let i = 1; i <= 6; i++) edit(h, 'src/a.ts', `v${i}\n`, t0 + i * 1000);

    expect(read(h.dir, 'src/a.ts')).toBe('v6\n');
    const [alarm] = eventsOf(h, 'loop-detected');
    expect(alarm.severity).toBe('critical');
    expect(alarm.message).toBe(
      'Circuit breaker: src/a.ts changed 6 times within 60 s (limit 5); revert restores the version before this series',
    );
    expect(eventsOf(h, 'rollback')).toEqual([]);
    expect(h.session.getSnapshot().trippedFiles).toEqual(['src/a.ts']);
  });
});

describe('revert goes back to the last stable version, never further', () => {
  it('undoes the latest series of changes and keeps the stable work before it', () => {
    // A long session: good work at 9:00 that stays, then a thrashing series at 10:00
    const h = createHarness({ files: { 'src/a.ts': 'start\n' } });
    h.watcher.createCheckpoint();
    const t0 = Date.now() - 2 * 60 * MINUTE;
    edit(h, 'src/a.ts', 'good work\n', t0);
    edit(h, 'src/a.ts', 'loop 1\n', t0 + 60 * MINUTE);
    edit(h, 'src/a.ts', 'loop 2\n', t0 + 60 * MINUTE + 5_000);

    expect(h.session.rollbackFile('src/a.ts')).toBe(true);
    expect(read(h.dir, 'src/a.ts')).toBe('good work\n');
    expect(eventsOf(h, 'rollback')[0].message).toMatch(
      /^Rolled back src\/a\.ts to the version before its latest changes \(replaced version kept: /,
    );
    // a second revert does not go further back
    h.session.rollbackFile('src/a.ts');
    expect(read(h.dir, 'src/a.ts')).toBe('good work\n');
    // it still differs from the session start, so it is still a modified file
    expect(h.session.getSnapshot().modifiedFiles).toContain('src/a.ts');
  });

  it('counts edits less than a minute apart as one series', () => {
    const h = createHarness({ files: { 'src/a.ts': 'start\n' } });
    h.watcher.createCheckpoint();
    const t0 = Date.now() - 10 * MINUTE;
    edit(h, 'src/a.ts', 'one\n', t0);
    edit(h, 'src/a.ts', 'two\n', t0 + 30_000);
    edit(h, 'src/a.ts', 'three\n', t0 + 80_000);

    h.session.rollbackFile('src/a.ts');
    expect(read(h.dir, 'src/a.ts')).toBe('start\n');
    // back at the session start: no longer a modified file
    expect(h.session.getSnapshot().modifiedFiles).not.toContain('src/a.ts');
  });

  it('keeps a file created earlier in the session, and removes only one created in the latest series', () => {
    const h = createHarness({ files: { 'src/a.ts': 'a\n' } });
    h.watcher.createCheckpoint();
    const t0 = Date.now() - 30 * MINUTE;
    edit(h, 'src/new.ts', 'new helper\n', t0, 'add');
    edit(h, 'src/new.ts', 'broken helper\n', t0 + 20 * MINUTE);
    edit(h, 'src/rogue.ts', 'rogue\n', t0 + 20 * MINUTE + 1_000, 'add');

    h.session.rollbackFile('src/new.ts');
    h.session.rollbackFile('src/rogue.ts');
    expect(read(h.dir, 'src/new.ts')).toBe('new helper\n');
    expect(exists(h.dir, 'src/rogue.ts')).toBe(false);
  });
});
