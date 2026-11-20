import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWatchdogApp,
  listenWatchdogServer,
  type RunningWatchdogServer,
  TOKEN_HEADER,
} from '../src/server.js';
import { getVersion } from '../src/version.js';
import { cleanupTmpDirs, createHarness, exists, type Harness, makeTmpDir, read, writeFiles } from './helpers/harness.js';

const running: RunningWatchdogServer[] = [];
const blockers: http.Server[] = [];

afterEach(async () => {
  for (const server of running.splice(0, running.length)) await server.close();
  for (const blocker of blockers.splice(0, blockers.length)) {
    await new Promise((resolve) => blocker.close(resolve));
  }
  cleanupTmpDirs();
});

function appFor(h: Harness, token = 'test-token-0123456789') {
  return createWatchdogApp({
    rootDir: h.dir,
    configManager: h.configManager,
    watcher: h.watcher,
    processMonitor: h.monitor,
    session: h.session,
    token,
  });
}

const json = (body: unknown) => JSON.stringify(body);
const withToken = (token: string, extra: Record<string, string> = {}) => ({
  [TOKEN_HEADER]: token,
  'Content-Type': 'application/json',
  ...extra,
});

describe('dashboard API: who may change things', () => {
  const mutations: Array<[string, string | undefined]> = [
    ['/api/pause', undefined],
    ['/api/resume', undefined],
    ['/api/kill/100', undefined],
    ['/api/rollback-file', json({ filePath: 'a.ts' })],
  ];

  it('rejects every state-changing request that does not carry the dashboard token', async () => {
    const h = createHarness({ files: { 'a.ts': 'a\n' }, procs: [{ pid: 100, name: 'claude', cmd: 'claude' }] });
    h.watcher.createCheckpoint();
    await h.monitor.scan();
    writeFiles(h.dir, { 'a.ts': 'changed\n' });
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    const { app } = appFor(h);

    for (const [route, body] of mutations) {
      const none = await app.request(route, { method: 'POST', body });
      expect(none.status, `${route} without token`).toBe(403);
      const wrong = await app.request(route, { method: 'POST', body, headers: withToken('wrong-token-0123456789') });
      expect(wrong.status, `${route} with a wrong token`).toBe(403);
      // a "simple" cross-site form post: no preflight, text/plain body
      const simple = await app.request(route, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example', Host: 'localhost:4321' },
      });
      expect(simple.status, `${route} as cross-site simple request`).toBe(403);
    }

    expect(h.kills).toEqual([]);
    expect(read(h.dir, 'a.ts')).toBe('changed\n');
  });

  it('rejects a valid token that arrives from another origin or site', async () => {
    const h = createHarness({ files: { 'a.ts': 'a\n' }, watcher: { keepDiscarded: false } });
    h.watcher.createCheckpoint();
    writeFiles(h.dir, { 'a.ts': 'changed\n' });
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    const { app, token } = appFor(h);

    const foreignOrigin = await app.request('/api/rollback-file', {
      method: 'POST',
      body: json({ filePath: 'a.ts' }),
      headers: withToken(token, { Host: 'localhost:4321', Origin: 'http://localhost:9999' }),
    });
    expect(foreignOrigin.status).toBe(403);

    const crossSite = await app.request('/api/rollback-file', {
      method: 'POST',
      body: json({ filePath: 'a.ts' }),
      headers: withToken(token, { Host: 'localhost:4321', 'Sec-Fetch-Site': 'same-site' }),
    });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await app.request('/api/rollback-file', {
      method: 'POST',
      body: json({ filePath: 'a.ts' }),
      headers: withToken(token, {
        Host: 'localhost:4321',
        Origin: 'http://localhost:4321',
        'Sec-Fetch-Site': 'same-origin',
      }),
    });
    expect(sameOrigin.status).toBe(200);
    expect(read(h.dir, 'a.ts')).toBe('a\n');
  });

  it('answers only when addressed as this machine (DNS rebinding)', async () => {
    const h = createHarness();
    const { app } = appFor(h);

    for (const host of ['evil.example', 'evil.example:4321', 'localhost.evil.example:4321', '192.168.1.20:4321']) {
      const res = await app.request('/api/status', { headers: { Host: host } });
      expect(res.status, host).toBe(403);
      const page = await app.request('/', { headers: { Host: host } });
      expect(page.status, host).toBe(403);
    }
    for (const host of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321', 'LOCALHOST:4321', 'localhost']) {
      const res = await app.request('/api/status', { headers: { Host: host } });
      expect(res.status, host).toBe(200);
    }
  });
});

describe('dashboard API: what the actions do', () => {
  it('kills monitored PIDs only', async () => {
    const h = createHarness({ procs: [{ pid: 100, name: 'claude', cmd: 'claude', cpu: 1 }] });
    await h.monitor.scan();
    const { app, token } = appFor(h);

    const stranger = await app.request('/api/kill/4242', { method: 'POST', headers: withToken(token) });
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ ok: false, error: expect.stringContaining('not a monitored') });

    for (const bad of ['0', '-5', 'abc', '1.5', '1e3x']) {
      const res = await app.request(`/api/kill/${bad}`, { method: 'POST', headers: withToken(token) });
      expect([400, 404], bad).toContain(res.status);
    }
    expect(h.kills).toEqual([]);

    const known = await app.request('/api/kill/100', { method: 'POST', headers: withToken(token) });
    expect(known.status).toBe(200);
    expect(h.kills).toEqual([{ pid: 100, signal: 'SIGTERM' }]);
  });

  it('ends an agent session only with the processes the dashboard confirmed, and only those of that session', async () => {
    const h = createHarness({
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', cpu: 1 },
        { pid: 101, ppid: 100, name: 'node', cmd: 'node /x/node_modules/.bin/mcp-server-git' },
        { pid: 200, name: 'claude', cmd: 'claude', cpu: 1, cwd: '/work/other-repo' },
      ],
    });
    await h.monitor.scan();
    const { app, token } = appFor(h);
    const seen = (pid: number) => h.session.getSnapshot().processes.find((p) => p.pid === pid)!.firstSeenAt;
    const request = (body: string) => app.request('/api/kill/100', { method: 'POST', headers: withToken(token), body });

    const tooMany = Array.from({ length: 513 }, (_, i) => ({ pid: i + 1, firstSeenAt: 0 }));
    for (const body of [
      '{"also": "101"}',
      '{"also": [101]}',
      '{"also": [{"pid": -1, "firstSeenAt": 0}]}',
      '{"also": [{"pid": 1.5, "firstSeenAt": 0}]}',
      '{"also": [{"pid": 101}]}',
      '{"also": [null]}',
      '{"also": null}',
      '{"firstSeenAt": "yesterday"}',
      json({ also: tooMany }),
      '{not json',
    ]) {
      expect((await request(body)).status, body.slice(0, 40)).toBe(400);
    }
    const huge = await request(json({ also: [], padding: 'x'.repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
    expect(h.kills).toEqual([]);

    // the PID no longer names the process the dialog showed
    const other = await request(json({ firstSeenAt: seen(100) + 1 }));
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: expect.stringContaining('different process') });
    expect(h.kills).toEqual([]);

    const res = await request(
      json({ firstSeenAt: seen(100), also: [{ pid: 101, firstSeenAt: seen(101) }, { pid: 200, firstSeenAt: seen(200) }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pid: 100, targetSignalled: true, alsoEnded: [101], leftRunning: [], notFound: [200], failed: [] });
    expect(h.kills.map((k) => k.pid)).toEqual([100, 101]);
  });

  it('has no route that terminates processes in bulk because of their status', async () => {
    const h = createHarness({
      procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: '/work/other-repo', etime: '03-00:00:00', cpuTimeSec: 1.5 }],
    });
    await h.monitor.scan();
    expect(h.session.getSnapshot().processes[0].status).toBe('STALE');
    const { app, token } = appFor(h);

    const res = await app.request('/api/kill-frozen', { method: 'POST', headers: withToken(token) });
    expect(res.status).toBe(404);
    expect(h.kills).toEqual([]);
  });

  it('cannot be used to reach files outside the repository', async () => {
    const outside = makeTmpDir('agent-leash-outside-');
    writeFiles(outside, { 'victim.txt': 'precious\n' });
    const h = createHarness({ files: { 'a.ts': 'a\n' } });
    h.watcher.createCheckpoint();
    const { app, token } = appFor(h);

    const attempts = [
      path.relative(h.dir, path.join(outside, 'victim.txt')),
      path.join(outside, 'victim.txt'),
      '.git/config',
      '',
    ];
    for (const filePath of attempts) {
      const res = await app.request('/api/rollback-file', {
        method: 'POST',
        headers: withToken(token),
        body: json({ filePath }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok ?? false, filePath).toBe(false);
    }
    const notAString = await app.request('/api/rollback-file', {
      method: 'POST',
      headers: withToken(token),
      body: json({ filePath: { path: 'a.ts' } }),
    });
    expect(notAString.status).toBe(400);
    expect(exists(outside, 'victim.txt')).toBe(true);
  });

  it('validates input, pauses and resumes the agents of the repository', async () => {
    const h = createHarness({
      files: { 'a.ts': 'a\n' },
      watcher: { keepDiscarded: false },
      procs: [{ pid: 100, name: 'claude', cmd: 'claude', cpu: 1 }],
    });
    h.procs[0].cwd = h.dir;
    h.watcher.createCheckpoint();
    await h.monitor.scan();
    writeFiles(h.dir, { 'a.ts': 'changed\n' });
    h.watcher.handleFileSystemEvent('change', 'a.ts');
    const { app, token } = appFor(h);

    for (const filePath of ['', 5, null]) {
      const res = await app.request('/api/rollback-file', { method: 'POST', headers: withToken(token), body: json({ filePath }) });
      expect(res.status).toBe(400);
    }
    const malformed = await app.request('/api/rollback-file', { method: 'POST', headers: withToken(token), body: '{not json' });
    expect(malformed.status).toBe(400);
    // there are no modes any more
    const mode = await app.request('/api/mode', { method: 'POST', headers: withToken(token), body: json({ mode: 'yolo' }) });
    expect(mode.status).toBe(404);

    // panic is gone: pause replaced it
    const panic = await app.request('/api/panic', { method: 'POST', headers: withToken(token) });
    expect(panic.status).toBe(404);

    const pause = await app.request('/api/pause', { method: 'POST', headers: withToken(token) });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ ok: true, pausedPids: [100] });
    expect(read(h.dir, 'a.ts')).toBe('changed\n');
    const resume = await app.request('/api/resume', { method: 'POST', headers: withToken(token) });
    expect(await resume.json()).toMatchObject({ ok: true, resumedPids: [100] });
    expect(h.kills).toEqual([
      { pid: 100, signal: 'SIGSTOP' },
      { pid: 100, signal: 'SIGCONT' },
    ]);
  });
});

describe('dashboard page', () => {
  it('is served with its token, the package version and a policy that blocks injected script', async () => {
    const h = createHarness();
    const { app, token } = appFor(h);

    const res = await app.request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('__LEASH_');
    expect(html).toContain(`<meta name="leash-token" content="${token}"`);
    expect(html).toContain(`v${getVersion()}`);

    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // a fresh nonce per response
    const again = await app.request('/');
    expect(again.headers.get('content-security-policy')).not.toBe(csp);
  });

  it('loads nothing from another host: its styles come from this server', async () => {
    // Audit D-07: the page loaded Tailwind's script from a CDN, third-party code on a page that
    // holds the token for the kill endpoints, and the policy had to allow that host.
    const h = createHarness();
    const { app } = appFor(h);
    const res = await app.request('/');
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
    expect(html).toContain('<link rel="stylesheet" href="/dashboard.css"');

    const css = await app.request('/dashboard.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await css.text();
    // classes the page uses, also ones its script puts together at runtime
    for (const selector of ['.max-w-7xl', '.bg-amber-950\\/60', '.lg\\:grid-cols-12', '.text-\\[10px\\]']) {
      expect(text, selector).toContain(selector);
    }
    expect(text).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it('never serves a page from the directory it happens to be started in', async () => {
    const decoy = makeTmpDir();
    writeFiles(decoy, { 'src/ui/public/index.html': '<html><body>decoy page from the watched repo</body></html>' });
    const h = createHarness();
    const { app } = appFor(h);
    const previous = process.cwd();
    process.chdir(decoy);
    try {
      const html = await (await app.request('/')).text();
      expect(html).not.toContain('decoy page');
      writeFiles(decoy, { 'src/ui/public/dashboard.css': 'body { display: none } /* decoy */' });
      expect(await (await app.request('/dashboard.css')).text()).not.toContain('decoy');
      expect(html).toContain('id="confirm-dialog"');
    } finally {
      process.chdir(previous);
    }
  });

  it('streams the current state to a connected dashboard', async () => {
    const h = createHarness({ files: { 'a.ts': 'a\n' } });
    h.watcher.createCheckpoint();
    const { app } = appFor(h);

    const res = await app.request('/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    const payload = JSON.parse(first.replace(/^data: /, '').trim()) as { type: string; status: { rootDir: string } };
    expect(payload.type).toBe('status');
    expect(payload.status.rootDir).toBe(h.dir);
  });
});

describe('listening', () => {
  function deps(h: Harness) {
    return {
      rootDir: h.dir,
      configManager: h.configManager,
      watcher: h.watcher,
      processMonitor: h.monitor,
      session: h.session,
    };
  }

  async function blockPort(): Promise<number> {
    const blocker = http.createServer((_req, res) => res.end('other app'));
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    return (blocker.address() as AddressInfo).port;
  }

  it('binds to the loopback interface and serves real HTTP requests', async () => {
    const h = createHarness();
    const server = await listenWatchdogServer({ ...deps(h), port: 0 });
    running.push(server);

    expect((server.server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(server.url).toBe(`http://localhost:${server.port}`);

    const status = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    expect(status.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/pause`, { method: 'POST' });
    expect(denied.status).toBe(403);
    const allowed = await fetch(`http://127.0.0.1:${server.port}/api/rollback-file`, {
      method: 'POST',
      headers: withToken(server.token),
      body: json({ filePath: 'not-modified.ts' }),
    });
    expect(allowed.status).toBe(200);
  });

  it('moves to the next port when the preferred one is taken', async () => {
    const taken = await blockPort();
    const h = createHarness();
    const server = await listenWatchdogServer({ ...deps(h), port: taken, maxPortAttempts: 30 });
    running.push(server);

    expect(server.port).toBeGreaterThan(taken);
    expect((await fetch(`${server.url.replace('localhost', '127.0.0.1')}/api/status`)).status).toBe(200);
  });

  it('fails with a readable message when the port was chosen explicitly', async () => {
    const taken = await blockPort();
    const h = createHarness();
    await expect(listenWatchdogServer({ ...deps(h), port: taken, strictPort: true })).rejects.toThrow(
      `Port ${taken} is already in use`,
    );
  });

  it('closes promptly even while a dashboard is connected to the event stream', async () => {
    const h = createHarness();
    const server = await listenWatchdogServer({ ...deps(h), port: 0 });
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${server.port}/api/events`, { signal: controller.signal });
    await stream.body!.getReader().read();

    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(1500);
    controller.abort();
  });

  it('ships the dashboard page it serves', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../src/ui/public/index.html'))).toBe(true);
  });
});
