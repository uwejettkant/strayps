import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardConfigManager } from '../src/core/guard-config.js';
import { RepoWatcher } from '../src/core/watcher.js';
import {
  cleanupTmpDirs,
  commitAll,
  exists,
  git,
  initGitRepo,
  makeTmpDir,
  read,
  writeFiles,
} from './helpers/harness.js';

const isPosix = process.platform !== 'win32';

afterEach(() => {
  cleanupTmpDirs();
  vi.useRealTimers();
});

function watcherFor(dir: string, options: Partial<ConstructorParameters<typeof RepoWatcher>[0]> = {}) {
  const watcher = new RepoWatcher({ rootDir: dir, ...options });
  watcher.createCheckpoint();
  return watcher;
}

describe('RepoWatcher rollback: what it may touch', () => {
  it('refuses relative and absolute paths outside the repository and leaves those files alone', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    const watcher = watcherFor(repo);

    const relative = path.relative(repo, path.join(outside, 'victim.txt'));
    expect(relative.startsWith('..')).toBe(true);

    expect(watcher.rollbackFile(relative)).toBe(false);
    expect(watcher.rollbackFile(path.join(outside, 'victim.txt'))).toBe(false);
    expect(watcher.rollbackFile('../'.repeat(12) + 'etc/hosts')).toBe(false);
    expect(watcher.rollbackFile('')).toBe(false);
    expect(watcher.rollbackFile('src/a.ts\0.txt')).toBe(false);

    expect(read(outside, 'victim.txt')).toBe('precious\n');
    const refusals = watcher.getRecentEvents().filter((e) => e.type === 'rollback-failed');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(refusals[0].severity).toBe('warn');
  });

  it('refuses ignored paths such as .git and node_modules, even though they are inside the repository', () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    writeFiles(repo, { 'a.ts': 'a\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
    commitAll(repo);
    const watcher = watcherFor(repo);

    expect(watcher.rollbackFile('.git/config')).toBe(false);
    expect(watcher.rollbackFile('.git/HEAD')).toBe(false);
    expect(watcher.rollbackFile('node_modules/pkg/index.js')).toBe(false);

    expect(exists(repo, '.git/config')).toBe(true);
    expect(exists(repo, '.git/HEAD')).toBe(true);
    expect(exists(repo, 'node_modules/pkg/index.js')).toBe(true);
  });

  it.skipIf(!isPosix)('refuses a path that leaves the repository through a symlinked directory', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    writeFiles(repo, { 'a.ts': 'a\n' });
    fs.symlinkSync(outside, path.join(repo, 'link'));
    const watcher = watcherFor(repo);

    expect(watcher.rollbackFile('link/victim.txt')).toBe(false);
    expect(read(outside, 'victim.txt')).toBe('precious\n');
  });

  it('never deletes a file that existed at session start just because it holds no copy of it', () => {
    const repo = makeTmpDir();
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    writeFiles(repo, { 'data/big.bin': big, 'a.ts': 'a\n' });
    const watcher = watcherFor(repo);
    // too large for the in-memory snapshot
    expect(watcher.getCheckpoint()?.snapshottedFiles).toBe(1);

    fs.appendFileSync(path.join(repo, 'data/big.bin'), 'x');
    watcher.handleFileSystemEvent('change', 'data/big.bin');

    expect(watcher.rollbackFile('data/big.bin')).toBe(false);
    expect(exists(repo, 'data/big.bin')).toBe(true);
    expect(fs.statSync(path.join(repo, 'data/big.bin')).size).toBe(big.length + 1);
  });

  it('restores a large tracked file from the git checkpoint without touching the index', () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 7);
    writeFiles(repo, { 'assets/big.bin': big, 'a.ts': 'a\n' });
    commitAll(repo);
    const watcher = watcherFor(repo);
    expect(watcher.getCheckpoint()?.type).toBe('git-head');

    fs.writeFileSync(path.join(repo, 'assets/big.bin'), 'overwritten by agent');
    watcher.handleFileSystemEvent('change', 'assets/big.bin');

    expect(watcher.rollbackFile('assets/big.bin')).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'assets/big.bin')).equals(big)).toBe(true);
    // nothing staged: the index still matches HEAD
    expect(execGitStatus(repo)).toBe('');
  });

  it.skipIf(!isPosix)('does not remove a symlink that existed at session start', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'shared/config.json': '{"v":1}\n' });
    fs.symlinkSync('shared/config.json', path.join(repo, 'config.json'));
    const watcher = watcherFor(repo);

    watcher.handleFileSystemEvent('change', 'config.json');
    expect(watcher.rollbackFile('config.json')).toBe(false);
    expect(fs.lstatSync(path.join(repo, 'config.json')).isSymbolicLink()).toBe(true);
  });

  it('removes a file created during the session and keeps a private copy of it', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo);

    writeFiles(repo, { 'src/rogue.ts': 'export const rogue = true;\n' });
    watcher.handleFileSystemEvent('add', 'src/rogue.ts');
    expect(watcher.getModifiedFiles()).toContain('src/rogue.ts');

    expect(watcher.rollbackFile('src/rogue.ts')).toBe(true);
    expect(exists(repo, 'src/rogue.ts')).toBe(false);
    expect(watcher.getModifiedFiles()).not.toContain('src/rogue.ts');

    const discardDir = watcher.getDiscardDir();
    expect(discardDir).toBeTruthy();
    const kept = path.join(discardDir!, '00001', 'src', 'rogue.ts');
    expect(fs.readFileSync(kept, 'utf-8')).toBe('export const rogue = true;\n');
    if (isPosix) {
      expect(fs.statSync(discardDir!).mode & 0o077).toBe(0);
    }
    fs.rmSync(discardDir!, { recursive: true, force: true });
  });

  it('keeps the replaced version when it rolls a modified file back, and reports where', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'src/app.ts': 'original\n' });
    const watcher = watcherFor(repo);

    writeFiles(repo, { 'src/app.ts': 'three hours of agent work\n' });
    watcher.handleFileSystemEvent('change', 'src/app.ts');
    expect(watcher.rollbackFile('src/app.ts')).toBe(true);

    expect(read(repo, 'src/app.ts')).toBe('original\n');
    const rollback = watcher.getRecentEvents().find((e) => e.type === 'rollback');
    const keptPath = rollback?.message.match(/replaced version kept: (.+)\)$/)?.[1];
    expect(keptPath).toBeTruthy();
    expect(fs.readFileSync(keptPath!, 'utf-8')).toBe('three hours of agent work\n');
    fs.rmSync(watcher.getDiscardDir()!, { recursive: true, force: true });
  });

  it('can be told not to keep replaced versions', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'original\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    writeFiles(repo, { 'a.ts': 'changed\n' });
    watcher.handleFileSystemEvent('change', 'a.ts');

    expect(watcher.rollbackFile('a.ts')).toBe(true);
    expect(watcher.getDiscardDir()).toBeNull();
  });

  it('never reads, restores or copies .env files', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { '.env': 'SECRET=1\n', 'config/.env.production': 'SECRET=2\n', 'a.ts': 'a\n' });
    const watcher = watcherFor(repo);

    writeFiles(repo, { '.env': 'SECRET=changed\n', 'a.ts': 'changed\n' });
    watcher.handleFileSystemEvent('change', '.env');
    watcher.handleFileSystemEvent('change', 'a.ts');

    expect(watcher.rollbackFile('.env')).toBe(false);
    expect(watcher.rollbackFile('a.ts')).toBe(true);
    expect(read(repo, '.env')).toBe('SECRET=changed\n');

    const discardDir = watcher.getDiscardDir()!;
    const keptFiles = fs.readdirSync(discardDir, { recursive: true }).map(String);
    expect(keptFiles.some((f) => f.includes('.env'))).toBe(false);
    fs.rmSync(discardDir, { recursive: true, force: true });
  });

  it.skipIf(!isPosix)('never writes through a symlink an agent put in place of a file', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    const watcher = watcherFor(repo);

    fs.rmSync(path.join(repo, 'src/a.ts'));
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(repo, 'src/a.ts'));
    watcher.handleFileSystemEvent('change', 'src/a.ts');

    expect(watcher.rollbackFile('src/a.ts')).toBe(false);
    expect(read(outside, 'victim.txt')).toBe('precious\n');
    expect(fs.lstatSync(path.join(repo, 'src/a.ts')).isSymbolicLink()).toBe(true);
    // nothing of the link's target was copied either
    const discardDir = watcher.getDiscardDir();
    if (discardDir) {
      const kept = fs.readdirSync(discardDir, { recursive: true }).map(String);
      for (const file of kept) {
        const full = path.join(discardDir, file);
        if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf-8')).not.toContain('precious');
      }
    }
    expect(watcher.getRecentEvents()[0].message).toContain('symbolic link');
  });

  it.skipIf(!isPosix)('removes a link an agent created in the session, and never what it points to', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    const watcher = watcherFor(repo);

    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(repo, 'src/bad-link.ts'));
    watcher.handleFileSystemEvent('add', 'src/bad-link.ts');
    fs.linkSync(path.join(outside, 'victim.txt'), path.join(repo, 'src/hard.ts'));
    watcher.handleFileSystemEvent('add', 'src/hard.ts');

    expect(watcher.rollbackFile('src/bad-link.ts')).toBe(true);
    expect(watcher.rollbackFile('src/hard.ts')).toBe(true);
    expect(exists(repo, 'src/bad-link.ts')).toBe(false);
    expect(exists(repo, 'src/hard.ts')).toBe(false);
    expect(read(outside, 'victim.txt')).toBe('precious\n');
    expect(watcher.getRecentEvents()[0].message).toContain('what it pointed to is untouched');
    // nothing of the target was copied
    const discardDir = watcher.getDiscardDir();
    if (discardDir) expect(fs.readdirSync(discardDir, { recursive: true }).length).toBe(0);
  });

  it.skipIf(!isPosix)('does not crawl a directory link that leads outside, but keeps watching file links', () => {
    // chokidar follows links: a link to ~ would have it crawl the whole home directory
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'deep/x.txt': 'x\n', '.env': 'SECRET=1\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    fs.symlinkSync(outside, path.join(repo, 'ext'));
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'src-alias'));
    fs.symlinkSync(path.join(outside, '.env'), path.join(repo, '.env'));
    const watcher = watcherFor(repo);

    expect(watcher.shouldIgnorePath(path.join(repo, 'ext'))).toBe(true);
    // unless a protected glob names that directory: its files still raise alarms
    const protecting = watcherFor(repo, { configManager: new GuardConfigManager(repo, { protectedFiles: ['ext/**'] }) });
    expect(protecting.shouldIgnorePath(path.join(repo, 'ext'))).toBe(false);
    // a link to a directory inside the repository, and a link to a file, stay watched
    expect(watcher.shouldIgnorePath(path.join(repo, 'src-alias'))).toBe(false);
    expect(watcher.shouldIgnorePath(path.join(repo, '.env'))).toBe(false);
  });

  it.skipIf(!isPosix)('treats a file reached through an alias directory as the real file', () => {
    // .claude/skills links to .agents/skills: under the alias, a file that existed at the start
    // looked new, and a revert would have deleted the real one
    const repo = makeTmpDir();
    writeFiles(repo, { 'real/x.md': 'start\n' });
    fs.symlinkSync(path.join(repo, 'real'), path.join(repo, 'alias'));
    const watcher = watcherFor(repo, { keepDiscarded: false });

    writeFiles(repo, { 'alias/x.md': 'changed\n' });
    watcher.handleFileSystemEvent('change', 'alias/x.md');
    expect(watcher.getModifiedFiles()).toEqual(['real/x.md']);
    expect(watcher.rollbackFile('alias/x.md')).toBe(true);
    expect(read(repo, 'real/x.md')).toBe('start\n');
  });

  it.skipIf(!isPosix)('never reads .env contents through a symlink with another name', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { '.env': 'SECRET=from-env\n', 'src/keep.ts': 'k\n' });
    const watcher = watcherFor(repo);
    const t0 = Date.now();

    fs.symlinkSync('../.env', path.join(repo, 'src/tmp.txt'));
    watcher.handleFileSystemEvent('add', 'src/tmp.txt', t0);
    // a minute later the link becomes a plain file: the linked version is now the rollback target
    fs.rmSync(path.join(repo, 'src/tmp.txt'));
    writeFiles(repo, { 'src/tmp.txt': 'plain\n' });
    watcher.handleFileSystemEvent('change', 'src/tmp.txt', t0 + 61_000);

    watcher.rollbackFile('src/tmp.txt');
    expect(read(repo, 'src/tmp.txt')).not.toContain('SECRET');
  });

  it.skipIf(!isPosix)('is not blocked by a FIFO, and never removes one that was there at the start', () => {
    // Opening a FIFO for reading waits for a writer; it froze the whole watchdog, signals included.
    // A FIFO or socket that existed before the session (a dev server's socket) is never removed.
    const repo = makeTmpDir();
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    execFileSync('mkfifo', [path.join(repo, 'src/pipe')]);
    const watcherModule = fileURLToPath(new URL('../src/core/watcher.ts', import.meta.url));
    const script = `
      const mod = await import(${JSON.stringify(watcherModule)});
      const RepoWatcher = mod.RepoWatcher ?? mod.default.RepoWatcher;
      const { execFileSync } = await import('node:child_process');
      const watcher = new RepoWatcher({ rootDir: ${JSON.stringify(repo)}, keepDiscarded: false });
      watcher.createCheckpoint();
      watcher.handleFileSystemEvent('change', 'src/pipe');
      const existing = watcher.rollbackFile('src/pipe') ? 'removed' : 'refused';
      execFileSync('mkfifo', [${JSON.stringify(path.join(repo, 'src/new-pipe'))}]);
      watcher.handleFileSystemEvent('add', 'src/new-pipe');
      const created = watcher.rollbackFile('src/new-pipe') ? 'removed' : 'refused';
      console.log(existing + ' ' + created);
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(output.trim()).toBe('refused removed');
    expect(fs.lstatSync(path.join(repo, 'src/pipe')).isFIFO()).toBe(true);
    expect(exists(repo, 'src/new-pipe')).toBe(false);
  });

  it('refuses to roll back a path that became a directory, without ending the watchdog', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    writeFiles(repo, { out: 'x\n' });
    watcher.handleFileSystemEvent('add', 'out');
    fs.rmSync(path.join(repo, 'out'));
    fs.mkdirSync(path.join(repo, 'out'));
    expect(() => watcher.rollbackFile('out')).not.toThrow();
    expect(fs.statSync(path.join(repo, 'out')).isDirectory()).toBe(true);
    expect(watcher.getRecentEvents()[0].message).toContain('it is a directory now');
  });

  it.skipIf(!isPosix)('never deletes what replaced a directory link that was there at the start', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'guide.md': 'g\n' });
    writeFiles(repo, { 'a.ts': 'a\n' });
    fs.symlinkSync(outside, path.join(repo, 'docs'));
    const watcher = watcherFor(repo);

    // the agent replaces the link with a plain file of the same name
    fs.rmSync(path.join(repo, 'docs'));
    writeFiles(repo, { docs: 'now a file\n' });
    watcher.handleFileSystemEvent('add', 'docs');
    expect(watcher.rollbackFile('docs')).toBe(false);
    expect(read(repo, 'docs')).toBe('now a file\n');
  });

  it.skipIf(!isPosix)('never writes to or reads another file through a hard link', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n', '.env': 'SECRET=hard\n' });
    const watcher = watcherFor(repo);

    // a second name for a file outside the repository, in place of src/a.ts
    fs.rmSync(path.join(repo, 'src/a.ts'));
    fs.linkSync(path.join(outside, 'victim.txt'), path.join(repo, 'src/a.ts'));
    watcher.handleFileSystemEvent('change', 'src/a.ts');
    expect(watcher.rollbackFile('src/a.ts')).toBe(false);
    expect(read(outside, 'victim.txt')).toBe('precious\n');
    expect(watcher.getRecentEvents()[0].message).toContain('hard link');

    // a second name for .env: its contents never become a version to restore
    const t0 = Date.now();
    fs.linkSync(path.join(repo, '.env'), path.join(repo, 'src/notes.txt'));
    watcher.handleFileSystemEvent('add', 'src/notes.txt', t0);
    fs.rmSync(path.join(repo, 'src/notes.txt'));
    writeFiles(repo, { 'src/notes.txt': 'plain\n' });
    watcher.handleFileSystemEvent('change', 'src/notes.txt', t0 + 61_000);
    watcher.rollbackFile('src/notes.txt');
    expect(read(repo, 'src/notes.txt')).not.toContain('SECRET');
  });

  it.skipIf(!isPosix)('restores exactly the named file from git, even when its name looks like a pattern', () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    const big = (fill: number) => Buffer.alloc(5 * 1024 * 1024 + 10, fill);
    writeFiles(repo, { 'big*.bin': big(1), 'bigX.bin': big(2) });
    commitAll(repo);
    const watcher = watcherFor(repo, { keepDiscarded: false });

    writeFiles(repo, { 'big*.bin': 'changed 1', 'bigX.bin': 'changed 2' });
    watcher.handleFileSystemEvent('change', 'big*.bin');
    watcher.handleFileSystemEvent('change', 'bigX.bin');

    expect(watcher.rollbackFile('big*.bin')).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'big*.bin')).equals(big(1))).toBe(true);
    // without literal pathspecs, git took "big*.bin" as a pattern and restored this one too
    expect(read(repo, 'bigX.bin')).toBe('changed 2');
  });

  it.skipIf(!isPosix)('never reads a file reached through a directory link that leads outside', () => {
    const outside = makeTmpDir('agent-leash-outside-');
    const repo = makeTmpDir();
    writeFiles(outside, { 'x.txt': 'outside-secret\n' });
    writeFiles(repo, { 'src/a.ts': 'a\n' });
    fs.symlinkSync(outside, path.join(repo, 'shared'));
    const watcher = watcherFor(repo, { keepDiscarded: false });
    const t0 = Date.now();

    watcher.handleFileSystemEvent('add', 'shared/x.txt', t0);
    // a minute later the link is a real directory: the version seen through the link is the target
    fs.rmSync(path.join(repo, 'shared'));
    writeFiles(repo, { 'shared/x.txt': 'plain\n' });
    watcher.handleFileSystemEvent('change', 'shared/x.txt', t0 + 61_000);
    watcher.rollbackFile('shared/x.txt');
    expect(read(repo, 'shared/x.txt')).not.toContain('outside-secret');
  });

  it('treats another spelling of an existing name as that file where the file system ignores case', () => {
    // On macOS, a write to readme.md changes README.md; tracked under the other spelling, the file
    // looked new, and a revert would have deleted README.md instead of restoring it
    const repo = makeTmpDir();
    writeFiles(repo, { 'README.md': 'start\n' });
    const caseInsensitive = fs.existsSync(path.join(repo, 'readme.md'));
    const watcher = watcherFor(repo, { keepDiscarded: false });

    fs.writeFileSync(path.join(repo, 'readme.md'), 'changed\n');
    watcher.handleFileSystemEvent('change', 'readme.md');
    if (!caseInsensitive) {
      // a case-sensitive file system: readme.md is a file of its own
      expect(watcher.getModifiedFiles()).toEqual(['readme.md']);
      return;
    }
    expect(watcher.getModifiedFiles()).toEqual(['README.md']);
    expect(watcher.rollbackFile('readme.md')).toBe(true);
    expect(fs.readdirSync(repo)).toContain('README.md');
    expect(read(repo, 'README.md')).toBe('start\n');
  });

  it('learns a spelling from the file system, never from a refused revert', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);
    expect(watcher.rollbackFile('Docker-Compose.yml')).toBe(false);
    writeFiles(repo, { 'docker-compose.yml': 'v1\n' });
    watcher.handleFileSystemEvent('add', 'docker-compose.yml');
    expect(watcher.getModifiedFiles()).toEqual(['docker-compose.yml']);
    expect(onProtected).toHaveBeenCalledTimes(1);
  });

  it('detects whether case matters from a file inside the repository', () => {
    // a repository whose own name has no letters, like ~/code/2024
    const parent = makeTmpDir();
    const repo = path.join(parent, '2024');
    writeFiles(repo, { 'README.md': 'start\n' });
    const caseInsensitive = fs.existsSync(path.join(repo, 'readme.md'));
    const watcher = watcherFor(repo, { keepDiscarded: false });
    fs.writeFileSync(path.join(repo, 'readme.md'), 'changed\n');
    watcher.handleFileSystemEvent('change', 'readme.md');
    expect(watcher.getModifiedFiles()).toEqual([caseInsensitive ? 'README.md' : 'readme.md']);
  });

  it('does not let another spelling of a name reach .env or an unchanged file', () => {
    // macOS file systems ignore case: ".ENV" opens .env, "readme.md" opens README.md
    const repo = makeTmpDir();
    writeFiles(repo, { '.env': 'SECRET=1\n', 'README.md': 'readme\n', '.envrc': 'export TOKEN=2\n' });
    const watcher = watcherFor(repo);

    expect(watcher.isEnvFile('.ENV')).toBe(true);
    expect(watcher.isEnvFile('config/.Env.Local')).toBe(true);
    // the default glob .env* covers .envrc, so its contents are never read either
    expect(watcher.isEnvFile('.envrc')).toBe(true);
    expect(watcher.getCheckpoint()?.snapshottedFiles).toBe(1);

    for (const name of ['.ENV', 'readme.md', 'README.md', '.envrc']) {
      expect(watcher.rollbackFile(name), name).toBe(false);
    }
    expect(read(repo, '.env')).toBe('SECRET=1\n');
    expect(read(repo, 'README.md')).toBe('readme\n');
    expect(read(repo, '.envrc')).toBe('export TOKEN=2\n');
    const messages = watcher.getRecentEvents().map((e) => e.message);
    // where the file system ignores case, the refusal names the file as it is known
    const caseInsensitive = fs.existsSync(path.join(repo, 'readme.md'));
    expect(messages).toContain(
      `Could not roll back ${caseInsensitive ? 'README.md' : 'readme.md'}: it was not changed in this session, left untouched`,
    );
    expect(messages).toContain(
      `Could not roll back ${caseInsensitive ? '.env' : '.ENV'}: it is a .env file; agent-leash never reads or writes those`,
    );
  });

  it.skipIf(!isPosix)('handles file names that contain backslashes, quotes and markup', () => {
    const repo = makeTmpDir();
    const odd = `src/it's "odd" <b>back\\slash</b>.ts`;
    writeFiles(repo, { [odd]: 'original\n' });
    const watcher = watcherFor(repo);

    writeFiles(repo, { [odd]: 'changed\n' });
    watcher.handleFileSystemEvent('change', path.join(repo, odd));
    expect(watcher.getModifiedFiles()).toEqual([odd]);

    expect(watcher.rollbackFile(odd)).toBe(true);
    expect(read(repo, odd)).toBe('original\n');
    fs.rmSync(watcher.getDiscardDir()!, { recursive: true, force: true });
  });
});

describe('RepoWatcher protected files', () => {
  it('applies directory patterns like secrets/** even when started from another directory', () => {
    const repo = makeTmpDir();
    expect(process.cwd()).not.toBe(repo);
    writeFiles(repo, {
      'secrets/key.pem': 'original key\n',
      'prisma/schema.prisma': 'model A {}\n',
      'src/secrets/not-protected.ts': 'x\n',
    });
    const configManager = new GuardConfigManager(repo, {
      protectedFiles: ['secrets/**', 'prisma/schema.prisma'],
    });
    const watcher = new RepoWatcher({ rootDir: repo, configManager, keepDiscarded: false });
    watcher.createCheckpoint();
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    writeFiles(repo, { 'secrets/key.pem': 'tampered\n', 'prisma/schema.prisma': 'model B {}\n' });
    watcher.handleFileSystemEvent('change', 'secrets/key.pem');
    watcher.handleFileSystemEvent('change', path.join(repo, 'prisma/schema.prisma'));
    watcher.handleFileSystemEvent('change', 'src/secrets/not-protected.ts');

    expect(onProtected).toHaveBeenCalledTimes(2);
    expect(onProtected.mock.calls.map((call) => call[0].filePath)).toEqual(['secrets/key.pem', 'prisma/schema.prisma']);
    // an alarm, never an automatic rollback
    expect(read(repo, 'secrets/key.pem')).toBe('tampered\n');
  });
});

describe('RepoWatcher and .gitignore', () => {
  // a repository with a virtual environment and a local database was snapshotted with
  // 10,769 files (224 MB), 10,723 of them ignored by git, and a SQLite file written more than five
  // times a minute raised the thrashing alarm while the application had it open.
  function ignoredRepo() {
    const repo = makeTmpDir();
    initGitRepo(repo);
    writeFiles(repo, {
      '.gitignore': '.venv/\n*.sqlite\n*.log\nsecrets/\n.env\n',
      'src/app.py': 'print(1)\n',
      '.venv/lib/site.py': 'x = 1\n',
      'data/app.sqlite': 'db v1',
      'secrets/key.pem': 'original key\n',
      '.env': 'TOKEN=[PLACEHOLDER]\n',
    });
    commitAll(repo);
    return repo;
  }

  it('does not snapshot, watch or roll back files that git ignores', () => {
    const repo = ignoredRepo();
    const watcher = watcherFor(repo, { keepDiscarded: false });
    // .gitignore and src/app.py only; .env is protected and watched, but its contents are never read
    expect(watcher.getCheckpoint()?.snapshottedFiles).toBe(2);

    // the directory is entered, since the default .env* could match a file in it; its files are not
    expect(watcher.shouldIgnorePath(path.join(repo, '.venv'))).toBe(false);
    expect(watcher.shouldIgnorePath(path.join(repo, '.venv/lib/site.py'))).toBe(true);
    expect(watcher.shouldIgnorePath(path.join(repo, 'src/app.py'))).toBe(false);

    const onLoop = vi.fn();
    watcher.on('loop-detected', onLoop);
    for (let i = 0; i < 12; i++) {
      writeFiles(repo, { 'data/app.sqlite': `db v${i + 2}` });
      watcher.handleFileSystemEvent('change', 'data/app.sqlite', Date.now() + i);
    }
    expect(onLoop).not.toHaveBeenCalled();
    expect(watcher.getModifiedFiles()).toEqual([]);
    expect(watcher.rollbackFile('data/app.sqlite')).toBe(false);
    expect(read(repo, 'data/app.sqlite')).toBe('db v13');
  });

  it.skipIf(!isPosix)('notices ignore rules put in place as a link, without reading through an in-repo link', () => {
    const repo = ignoredRepo();
    const outside = makeTmpDir('agent-leash-outside-');
    writeFiles(outside, { rules: '*.gen\n' });
    const watcher = watcherFor(repo);
    // .git/info/exclude did not change, but a .gitignore in a subdirectory appears as a link
    fs.symlinkSync(path.join(outside, 'rules'), path.join(repo, 'src/.gitignore'));
    writeFiles(repo, { 'src/b.gen': 'x\n' });
    watcher.handleFileSystemEvent('add', 'src/b.gen');
    expect(watcher.getModifiedFiles()).toContain('src/b.gen');
  });

  it('ignores a file created during the session when git ignores it', () => {
    const repo = ignoredRepo();
    const watcher = watcherFor(repo);
    writeFiles(repo, { 'src/debug.log': 'line\n', 'src/new.py': 'print(2)\n' });
    watcher.handleFileSystemEvent('add', 'src/debug.log');
    watcher.handleFileSystemEvent('add', 'src/new.py');
    expect(watcher.getModifiedFiles()).toEqual(['src/new.py']);
  });

  it('keeps watching a tracked file even if it matches .gitignore', () => {
    const repo = ignoredRepo();
    writeFiles(repo, { 'fixtures/seed.sqlite': 'seed v1' });
    git(repo, 'add', '-f', 'fixtures/seed.sqlite');
    git(repo, 'commit', '-q', '-m', 'seed');
    const watcher = watcherFor(repo, { keepDiscarded: false });

    writeFiles(repo, { 'fixtures/seed.sqlite': 'seed v2' });
    watcher.handleFileSystemEvent('change', 'fixtures/seed.sqlite');
    expect(watcher.getModifiedFiles()).toEqual(['fixtures/seed.sqlite']);
    expect(watcher.rollbackFile('fixtures/seed.sqlite')).toBe(true);
    expect(read(repo, 'fixtures/seed.sqlite')).toBe('seed v1');
  });

  it('keeps watching protected files that git ignores, also inside an ignored directory named by the glob', () => {
    const repo = ignoredRepo();
    const configManager = new GuardConfigManager(repo, { protectedFiles: ['.env*', 'secrets/**'] });
    const watcher = new RepoWatcher({ rootDir: repo, configManager, keepDiscarded: false });
    watcher.createCheckpoint();
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    expect(watcher.shouldIgnorePath(path.join(repo, 'secrets'))).toBe(false);
    writeFiles(repo, { 'secrets/key.pem': 'tampered\n', '.env': 'TOKEN=[OTHER]\n' });
    watcher.handleFileSystemEvent('change', 'secrets/key.pem');
    watcher.handleFileSystemEvent('change', '.env');

    expect(onProtected.mock.calls.map((call) => call[0].filePath)).toEqual(['secrets/key.pem', '.env']);
    // the protected file was snapshotted, so revert can restore it
    expect(watcher.rollbackFile('secrets/key.pem')).toBe(true);
    expect(read(repo, 'secrets/key.pem')).toBe('original key\n');
  });

  it('keeps raising alarms for protected files matched by name inside an ignored directory', () => {
    const repo = ignoredRepo();
    writeFiles(repo, { '.gitignore': 'local/\n', 'local/.env.production': 'A=[PLACEHOLDER]\n', 'local/docker-compose.yml': 'v1\n', 'local/cache.db': 'c1' });
    commitAll(repo, 'local');
    const watcher = watcherFor(repo, { keepDiscarded: false });
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    expect(watcher.shouldIgnorePath(path.join(repo, 'local'))).toBe(false);
    expect(watcher.shouldIgnorePath(path.join(repo, 'local/cache.db'))).toBe(true);
    // created during the session, in the ignored directory
    writeFiles(repo, { 'local/docker-compose.yml': 'v2\n', 'local/.env.staging': 'B=[PLACEHOLDER]\n' });
    watcher.handleFileSystemEvent('change', 'local/docker-compose.yml');
    watcher.handleFileSystemEvent('add', 'local/.env.staging');
    watcher.handleFileSystemEvent('change', 'local/cache.db');

    expect(onProtected.mock.calls.map((call) => call[0].filePath)).toEqual(['local/docker-compose.yml', 'local/.env.staging']);
    expect(watcher.rollbackFile('local/docker-compose.yml')).toBe(true);
    expect(read(repo, 'local/docker-compose.yml')).toBe('v1\n');
  });

  it('opens an ignored directory only for the protected files a glob names in it', () => {
    const repo = ignoredRepo();
    writeFiles(repo, { 'secrets/cache.sqlite': 'c1' });
    const configManager = new GuardConfigManager(repo, { protectedFiles: ['secrets/*.pem'] });
    const watcher = new RepoWatcher({ rootDir: repo, configManager, keepDiscarded: false });
    watcher.createCheckpoint();

    writeFiles(repo, { 'secrets/cache.sqlite': 'c2' });
    watcher.handleFileSystemEvent('change', 'secrets/cache.sqlite');
    expect(watcher.getModifiedFiles()).toEqual([]);
    expect(watcher.rollbackFile('secrets/cache.sqlite')).toBe(false);
    expect(read(repo, 'secrets/cache.sqlite')).toBe('c2');
  });

  it('does not let ignore rules written during the session hide new files', () => {
    const repo = ignoredRepo();
    const watcher = watcherFor(repo);
    // .git is never watched, so this edit itself leaves no trace
    fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n*.gen\n');
    writeFiles(repo, { 'src/a.gen': 'x\n' });
    watcher.handleFileSystemEvent('add', 'src/a.gen');

    writeFiles(repo, { '.gitignore': '.venv/\n*.sqlite\n*.log\nsecrets/\n.env\n*.out\n' });
    watcher.handleFileSystemEvent('change', '.gitignore');
    writeFiles(repo, { 'src/b.out': 'x\n' });
    watcher.handleFileSystemEvent('add', 'src/b.out');

    expect(watcher.getModifiedFiles().sort()).toEqual(['.gitignore', 'src/a.gen', 'src/b.out']);
  });

  it('never deletes an ignored file that existed at start, even after a reload protects it', () => {
    const repo = ignoredRepo();
    const configManager = new GuardConfigManager(repo);
    const watcher = new RepoWatcher({ rootDir: repo, configManager, keepDiscarded: false });
    watcher.createCheckpoint();
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    writeFiles(repo, { '.agentguard.json': JSON.stringify({ protectedFiles: ['.env*', 'data/*.sqlite'] }) });
    expect(configManager.reload().applied).toBe(true);
    writeFiles(repo, { 'data/app.sqlite': 'db v2' });
    watcher.handleFileSystemEvent('change', 'data/app.sqlite');
    expect(onProtected).toHaveBeenCalledTimes(1);

    // no copy of it exists, but it did exist: revert refuses instead of removing it
    expect(watcher.rollbackFile('data/app.sqlite')).toBe(false);
    expect(read(repo, 'data/app.sqlite')).toBe('db v2');
  });

  it('does not let a new .gitignore that ignores itself hide the files next to it', () => {
    const repo = ignoredRepo();
    const watcher = watcherFor(repo);
    writeFiles(repo, { 'src/.gitignore': '*\n', 'src/hidden.ts': 'x\n' });
    // chokidar may ask about the new file before it reports the new .gitignore
    expect(watcher.shouldIgnorePath(path.join(repo, 'src/hidden.ts'))).toBe(false);
    expect(watcher.shouldIgnorePath(path.join(repo, 'src/.gitignore'))).toBe(false);
  });

  it('watches a directory that the enclosing repository ignores like a directory outside git', () => {
    const repo = ignoredRepo();
    writeFiles(repo, { '.gitignore': 'scratch/\n', 'scratch/a.ts': 'a\n', 'scratch/node_modules/x.js': 'x\n' });
    const watcher = watcherFor(path.join(repo, 'scratch'));
    expect(watcher.getCheckpoint()?.snapshottedFiles).toBe(1);
    writeFiles(repo, { 'scratch/a.ts': 'b\n' });
    watcher.handleFileSystemEvent('change', 'a.ts');
    expect(watcher.getModifiedFiles()).toEqual(['a.ts']);
  });

  it('treats a file name that looks like an option as a path when it asks git', () => {
    const repo = ignoredRepo();
    const watcher = watcherFor(repo);
    writeFiles(repo, { '--help.log': 'x\n', '-q': 'x\n' });
    watcher.handleFileSystemEvent('add', '--help.log');
    watcher.handleFileSystemEvent('add', '-q');
    expect(watcher.getModifiedFiles()).toEqual(['-q']);
  });
});

describe('RepoWatcher rollback: bookkeeping', () => {
  it('raises one alarm per series of edits, and revert restores the version before the series', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'original\n' });
    const configManager = new GuardConfigManager(repo, {
      limits: { maxFilesWarn: 15, maxFilesHardStop: 40, maxEditsPerFilePerMinute: 2, mcpSilenceTimeoutSec: 45 },
    });
    const watcher = watcherFor(repo, { configManager, keepDiscarded: false });

    for (let i = 1; i <= 5; i++) {
      writeFiles(repo, { 'a.ts': `edit ${i}\n` });
      watcher.handleFileSystemEvent('change', 'a.ts');
    }
    expect(watcher.getRecentEvents().filter((e) => e.type === 'loop-detected')).toHaveLength(1);
    expect(read(repo, 'a.ts')).toBe('edit 5\n');

    expect(watcher.rollbackFile('a.ts')).toBe(true);
    expect(read(repo, 'a.ts')).toBe('original\n');
    // newest first
    expect(watcher.getRecentEvents(2).map((e) => e.type)).toEqual(['rollback', 'file-edit']);
  });

  it('raises a new alarm for a new series after a quiet minute', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'original\n' });
    const configManager = new GuardConfigManager(repo, {
      limits: { maxFilesWarn: 15, maxFilesHardStop: 40, maxEditsPerFilePerMinute: 2, mcpSilenceTimeoutSec: 45 },
    });
    const watcher = watcherFor(repo, { configManager, keepDiscarded: false });
    const t0 = Date.now() - 10 * 60_000;
    const series = (start: number) => {
      for (let i = 0; i < 3; i++) {
        writeFiles(repo, { 'a.ts': `edit ${start + i}\n` });
        watcher.handleFileSystemEvent('change', 'a.ts', start + i * 1000);
      }
    };

    series(t0);
    expect(watcher.loopDetector.getTrippedFiles(t0 + 3000)).toEqual(['a.ts']);
    // a minute without edits re-arms the breaker
    expect(watcher.loopDetector.getTrippedFiles(t0 + 2000 + 61_000)).toEqual([]);
    series(t0 + 5 * 60_000);
    expect(watcher.getRecentEvents().filter((e) => e.type === 'loop-detected')).toHaveLength(2);
  });

  it('treats the file system echo of its own rollback as its own, but not a new foreign edit', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'docker-compose.yml': 'version: "3.8"\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    const onProtected = vi.fn();
    watcher.on('protected-file', onProtected);

    writeFiles(repo, { 'docker-compose.yml': 'tampered\n' });
    watcher.handleFileSystemEvent('change', 'docker-compose.yml');
    expect(onProtected).toHaveBeenCalledTimes(1);
    // an alarm only; the revert is a person's decision
    expect(read(repo, 'docker-compose.yml')).toBe('tampered\n');
    expect(watcher.rollbackFile('docker-compose.yml')).toBe(true);
    expect(read(repo, 'docker-compose.yml')).toBe('version: "3.8"\n');

    // chokidar reports our own write, possibly late and more than once
    watcher.handleFileSystemEvent('change', 'docker-compose.yml');
    watcher.handleFileSystemEvent('change', 'docker-compose.yml');
    expect(onProtected).toHaveBeenCalledTimes(1);

    // the agent tampers again right away: that is not an echo
    writeFiles(repo, { 'docker-compose.yml': 'tampered again\n' });
    watcher.handleFileSystemEvent('change', 'docker-compose.yml');
    expect(onProtected).toHaveBeenCalledTimes(2);
    expect(read(repo, 'docker-compose.yml')).toBe('tampered again\n');
  });

  it('stops counting a file as modified once it is back at the checkpoint and re-arms the limits', () => {
    const repo = makeTmpDir();
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`f${i}.ts`] = 'original\n';
    writeFiles(repo, files);
    const configManager = new GuardConfigManager(repo, {
      limits: { maxFilesWarn: 2, maxFilesHardStop: 3, maxEditsPerFilePerMinute: 5, mcpSilenceTimeoutSec: 45 },
    });
    const watcher = watcherFor(repo, { configManager, keepDiscarded: false });
    const onHardStop = vi.fn();
    watcher.on('limit-hard-stop', onHardStop);

    for (let i = 0; i < 3; i++) {
      writeFiles(repo, { [`f${i}.ts`]: 'changed\n' });
      watcher.handleFileSystemEvent('change', `f${i}.ts`);
    }
    expect(onHardStop).toHaveBeenCalledTimes(1);
    expect(watcher.getLimitState()).toBe('hard-stop');

    expect(watcher.rollbackFile('f0.ts')).toBe(true);
    expect(watcher.rollbackFile('f1.ts')).toBe(true);
    expect(watcher.getModifiedFiles()).toEqual(['f2.ts']);
    expect(watcher.getLimitState()).toBe('ok');

    // crossing the limit a second time raises the alarm a second time
    for (const name of ['f0.ts', 'f1.ts']) {
      writeFiles(repo, { [name]: 'changed again\n' });
      watcher.handleFileSystemEvent('change', name);
    }
    expect(onHardStop).toHaveBeenCalledTimes(2);
  });

  it('counts files against the limits since the last commit, so a long session is not red forever', () => {
    // The count ran from the start of agent-leash: after a day of committed work it stayed at the
    // hard stop and said nothing any more
    const repo = makeTmpDir();
    initGitRepo(repo);
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`f${i}.ts`] = 'original\n';
    writeFiles(repo, files);
    commitAll(repo);
    const configManager = new GuardConfigManager(repo, {
      limits: { maxFilesWarn: 2, maxFilesHardStop: 3, maxEditsPerFilePerMinute: 5, mcpSilenceTimeoutSec: 45 },
    });
    const watcher = watcherFor(repo, { configManager, keepDiscarded: false });
    const onHardStop = vi.fn();
    watcher.on('limit-hard-stop', onHardStop);

    for (let i = 0; i < 3; i++) {
      writeFiles(repo, { [`f${i}.ts`]: 'changed\n' });
      watcher.handleFileSystemEvent('change', `f${i}.ts`);
    }
    expect(watcher.getLimitState()).toBe('hard-stop');
    expect(onHardStop).toHaveBeenCalledTimes(1);

    // two of the three are committed: only the third still counts
    git(repo, 'add', 'f0.ts', 'f1.ts');
    git(repo, 'commit', '-q', '-m', 'two files');
    watcher.checkCommits();
    expect(watcher.getUncommittedFiles()).toEqual(['f2.ts']);
    expect(watcher.getLimitState()).toBe('ok');
    expect(watcher.getRecentEvents()[0].message).toMatch(/^New commit [0-9a-f]{7}: 2 files committed, 1 changed file not committed$/);
    // what changed in the session can still be reverted, committed or not
    expect(watcher.getModifiedFiles().sort()).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(watcher.rollbackFile('f0.ts')).toBe(true);
    expect(read(repo, 'f0.ts')).toBe('original\n');

    // a committed file that changes again counts again, and crossing the limit alarms again
    writeFiles(repo, { 'f1.ts': 'changed again\n', 'f3.ts': 'changed\n' });
    watcher.handleFileSystemEvent('change', 'f1.ts');
    watcher.handleFileSystemEvent('change', 'f3.ts');
    // f0.ts is back at its session-start version after the revert and counts no more
    expect(watcher.getUncommittedFiles().sort()).toEqual(['f1.ts', 'f2.ts', 'f3.ts']);
    expect(onHardStop).toHaveBeenCalledTimes(2);

    // no new commit: nothing changes
    const before = watcher.getUncommittedFiles();
    watcher.checkCommits();
    expect(watcher.getUncommittedFiles()).toEqual(before);
  });

  it('notices the first commit of a repository that had none', () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    writeFiles(repo, { 'a.ts': 'b\n' });
    watcher.handleFileSystemEvent('change', 'a.ts');
    commitAll(repo);
    watcher.checkCommits();
    expect(watcher.getUncommittedFiles()).toEqual([]);
  });

  it('counts since its own start where there is no git repository', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo);
    writeFiles(repo, { 'a.ts': 'b\n' });
    watcher.handleFileSystemEvent('change', 'a.ts');
    watcher.checkCommits();
    expect(watcher.getUncommittedFiles()).toEqual(['a.ts']);
  });

  it('revert restores changed and deleted files and removes new ones, one at a time', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n', 'b.ts': 'b\n', 'untouched.ts': 'same\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    const untouchedMtime = fs.statSync(path.join(repo, 'untouched.ts')).mtimeMs;

    writeFiles(repo, { 'a.ts': 'changed\n', 'new.ts': 'new\n' });
    fs.rmSync(path.join(repo, 'b.ts'));
    watcher.handleFileSystemEvent('change', 'a.ts');
    watcher.handleFileSystemEvent('add', 'new.ts');
    watcher.handleFileSystemEvent('unlink', 'b.ts');

    for (const file of ['a.ts', 'b.ts', 'new.ts']) expect(watcher.rollbackFile(file), file).toBe(true);
    expect(read(repo, 'a.ts')).toBe('a\n');
    expect(read(repo, 'b.ts')).toBe('b\n');
    expect(exists(repo, 'new.ts')).toBe(false);
    expect(fs.statSync(path.join(repo, 'untouched.ts')).mtimeMs).toBe(untouchedMtime);
    expect(watcher.getModifiedFiles()).toEqual([]);
  });
});

describe('RepoWatcher dry run (demo mode)', () => {
  it('reads nothing, writes nothing and starts no file watcher', async () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    writeFiles(repo, { 'src/auth/session.ts': 'real committed work\n' });
    commitAll(repo);
    const objectsBefore = countGitObjects(repo);

    const watcher = new RepoWatcher({ rootDir: repo, dryRun: true });
    const checkpoint = await watcher.start();
    expect(checkpoint).toMatchObject({ ref: 'demo', snapshottedFiles: 0 });
    // `git stash create` would have written objects
    expect(countGitObjects(repo)).toBe(objectsBefore);

    writeFiles(repo, { 'src/auth/session.ts': 'uncommitted work during the demo\n' });
    for (let i = 0; i < 7; i++) watcher.handleFileSystemEvent('change', 'src/auth/session.ts');
    watcher.handleFileSystemEvent('add', 'src/new.ts');

    expect(watcher.rollbackFile('src/auth/session.ts')).toBe(true);
    expect(watcher.rollbackFile('src/new.ts')).toBe(true);

    expect(read(repo, 'src/auth/session.ts')).toBe('uncommitted work during the demo\n');
    expect(watcher.getDiscardDir()).toBeNull();
    const messages = watcher.getRecentEvents().map((e) => e.message).join('\n');
    expect(messages).toContain('Demo: would roll back src/auth/session.ts');
    expect(messages).toContain('no files touched');
    await watcher.stop();
  });
});

describe('RepoWatcher health', () => {
  it('reports once when the watched directory disappears', () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo);
    const onError = vi.fn();
    watcher.on('watch-error', onError);

    watcher.checkHealth();
    expect(onError).not.toHaveBeenCalled();

    fs.rmSync(repo, { recursive: true, force: true });
    watcher.checkHealth();
    watcher.checkHealth();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].severity).toBe('critical');
  });

  it('falls back to a memory snapshot in a git repository without commits', () => {
    const repo = makeTmpDir();
    initGitRepo(repo);
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = watcherFor(repo, { keepDiscarded: false });
    expect(watcher.getCheckpoint()?.type).toBe('memory-snapshot');

    writeFiles(repo, { 'a.ts': 'changed\n' });
    watcher.handleFileSystemEvent('change', 'a.ts');
    expect(watcher.rollbackFile('a.ts')).toBe(true);
    expect(read(repo, 'a.ts')).toBe('a\n');
  });

  it('survives a late file watcher error instead of crashing the process', async () => {
    const repo = makeTmpDir();
    writeFiles(repo, { 'a.ts': 'a\n' });
    const watcher = new RepoWatcher({ rootDir: repo });
    await watcher.start();
    const onError = vi.fn();
    watcher.on('watch-error', onError);
    try {
      const internal = (watcher as unknown as { watcher: { emit: (name: string, err: Error) => void } }).watcher;
      expect(() => internal.emit('error', new Error('EMFILE: too many open files'))).not.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain('EMFILE');
    } finally {
      await watcher.stop();
    }
  });

  // Known gap: the behavior is not decided yet (AGENTS.md, section 6)
  it.todo('does something on a hard stop besides reporting it');
});

function execGitStatus(repo: string): string {
  // staged or unstaged differences against HEAD, porcelain format
  return git(repo, 'status', '--porcelain');
}

function countGitObjects(repo: string): number {
  return Number(git(repo, 'count-objects').split(' ')[0]);
}
