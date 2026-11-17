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
    ['/api/panic', undefined],
    ['/api/kill-frozen', undefined],
    ['/api/kill/100', undefined],
    ['/api/mode', json({ mode: 'yolo' })],
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
    expect(h.session.getSnapshot().config.mode).toBe('balanced');
  });

  it('rejects a valid token that arrives from another origin or site', async () => {
    const h = createHarness();
    const { app, token } = appFor(h);

    const foreignOrigin = await app.request('/api/mode', {
      method: 'POST',
      body: json({ mode: 'yolo' }),
      headers: withToken(token, { Host: 'localhost:4321', Origin: 'http://localhost:9999' }),
    });
    expect(foreignOrigin.status).toBe(403);

    const crossSite = await app.request('/api/mode', {
      method: 'POST',
      body: json({ mode: 'yolo' }),
      headers: withToken(token, { Host: 'localhost:4321', 'Sec-Fetch-Site': 'same-site' }),
    });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await app.request('/api/mode', {
      method: 'POST',
      body: json({ mode: 'yolo' }),
      headers: withToken(token, {
        Host: 'localhost:4321',
        Origin: 'http://localhost:4321',
        'Sec-Fetch-Site': 'same-origin',
      }),
    });
    expect(sameOrigin.status).toBe(200);
    expect(h.session.getSnapshot().config.mode).toBe('yolo');
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

  it('validates the mode and reports the full result of a panic', async () => {
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

    for (const mode of ['garbage', '', 5]) {
      const res = await app.request('/api/mode', { method: 'POST', headers: withToken(token), body: json({ mode }) });
      expect(res.status).toBe(400);
    }
    const malformed = await app.request('/api/mode', { method: 'POST', headers: withToken(token), body: '{not json' });
    expect(malformed.status).toBe(400);

    const panic = await app.request('/api/panic', { method: 'POST', headers: withToken(token) });
    expect(panic.status).toBe(200);
    expect(await panic.json()).toMatchObject({
      ok: true,
      restoredFiles: ['a.ts'],
      restoredCount: 1,
      skippedFiles: [],
      killedPids: [100],
    });
    expect(h.kills).toEqual([{ pid: 100, signal: 'SIGKILL' }]);
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
      expect(html).toContain('id="panic-dialog"');
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
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/panic`, { method: 'POST' });
    expect(denied.status).toBe(403);
    const allowed = await fetch(`http://127.0.0.1:${server.port}/api/mode`, {
      method: 'POST',
      headers: withToken(server.token),
      body: json({ mode: 'strict' }),
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
