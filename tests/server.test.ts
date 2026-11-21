import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboardApp, listenDashboardServer, type RunningDashboardServer } from '../src/server.js';
import { getVersion } from '../src/version.js';
import { cleanupTmpDirs, createHarness, type Harness, makeTmpDir, writeFiles } from './helpers/harness.js';

const running: RunningDashboardServer[] = [];
const blockers: http.Server[] = [];

afterEach(async () => {
  for (const server of running.splice(0, running.length)) await server.close();
  for (const blocker of blockers.splice(0, blockers.length)) {
    await new Promise((resolve) => blocker.close(resolve));
  }
  cleanupTmpDirs();
});

function appFor(h: Harness) {
  return createDashboardApp({
    rootDir: h.dir,
    configManager: h.configManager,
    processMonitor: h.monitor,
    session: h.session,
  });
}

describe('dashboard API: read-only', () => {
  it('changes nothing: every request that is not a read is refused, whatever it carries', async () => {
    // the page held a token for the kill route, and any local process could load the page
    const h = createHarness({
      procs: [
        { pid: 100, name: 'claude', cmd: 'claude', cpu: 1 },
        { pid: 300, name: 'claude', cmd: 'claude', cwd: '/work/other-repo', etime: '03-00:00:00', cpuTimeSec: 1.5 },
      ],
    });
    h.procs[0].cwd = h.dir;
    await h.monitor.scan();
    const { app } = appFor(h);
    const sameOrigin = {
      Host: 'localhost:4321',
      Origin: 'http://localhost:4321',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    };

    for (const route of ['/api/kill/100', '/api/kill/300', '/api/kill-frozen', '/api/pause', '/api/resume', '/api/rollback-file', '/api/status', '/', '/dashboard.css', '/nope']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await app.request(route, { method, headers: sameOrigin, body: method === 'DELETE' ? undefined : '{}' });
        expect(res.status, `${method} ${route}`).toBe(405);
      }
    }
    expect(h.kills).toEqual([]);
    expect(h.session.getSnapshot().processes.every((p) => !p.paused)).toBe(true);
  });

  it('names the methods it allows, and gives the status to its own page, curl and scripts, not to another site', async () => {
    const h = createHarness();
    const { app } = appFor(h);
    const refused = await app.request('/api/status', { method: 'POST' });
    expect(refused.status).toBe(405);
    expect(refused.headers.get('allow')).toBe('GET, HEAD');

    for (const site of [undefined, 'same-origin', 'none']) {
      const res = await app.request('/api/status', { headers: site ? { 'Sec-Fetch-Site': site } : {} });
      expect(res.status, String(site)).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    for (const site of ['cross-site', 'same-site']) {
      const res = await app.request('/api/status', { headers: { 'Sec-Fetch-Site': site } });
      expect(res.status, site).toBe(403);
    }
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

  it('reports the processes it monitors', async () => {
    const h = createHarness({ procs: [{ pid: 100, name: 'claude', cmd: 'claude', cpu: 1 }] });
    await h.monitor.scan();
    const { app } = appFor(h);
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { rootDir: string; processes: Array<{ pid: number }> };
    expect(body.rootDir).toBe(h.dir);
    expect(body.processes.map((p) => p.pid)).toEqual([100]);
  });
});

describe('dashboard page', () => {
  it('is served with the package version, no token, and a policy that blocks injected script', async () => {
    const h = createHarness();
    const { app } = appFor(h);

    const res = await app.request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('__STRAYPS_');
    expect(html).not.toContain('leash-token');
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
    // the page loaded Tailwind's script from a CDN, third-party code that saw everything the page
    // shows, and the policy had to allow that host.
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
      expect(html).toContain('id="process-list"');
    } finally {
      process.chdir(previous);
    }
  });

  it('streams only to its own page, and a new tab replaces the oldest stream when all places are taken', async () => {
    const h = createHarness();
    const { app } = appFor(h);
    const crossSite = await app.request('/api/events', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);

    const readers = [];
    for (let i = 0; i < 16; i++) {
      const res = await app.request('/api/events', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      readers.push(reader);
    }
    // a 17th connection, say the dashboard after another process took all places: it gets in,
    // and the oldest stream ends instead
    const latest = await app.request('/api/events');
    expect(latest.status).toBe(200);
    const latestReader = latest.body!.getReader();
    await latestReader.read();
    expect((await readers[0].read()).done).toBe(true);
    expect(h.session.listenerCount('update')).toBeLessThanOrEqual(16 + 1);
    for (const reader of [...readers.slice(1), latestReader]) await reader.cancel();
  });

  it('streams the current state to a connected dashboard', async () => {
    const h = createHarness();
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
    const server = await listenDashboardServer({ ...deps(h), port: 0 });
    running.push(server);

    expect((server.server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(server.url).toBe(`http://localhost:${server.port}`);

    const status = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    expect(status.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/pause`, { method: 'POST' });
    expect(denied.status).toBe(405);
    expect(h.kills).toEqual([]);
  });

  it('moves to the next port when the preferred one is taken', async () => {
    const taken = await blockPort();
    const h = createHarness();
    const server = await listenDashboardServer({ ...deps(h), port: taken, maxPortAttempts: 30 });
    running.push(server);

    expect(server.port).toBeGreaterThan(taken);
    expect((await fetch(`${server.url.replace('localhost', '127.0.0.1')}/api/status`)).status).toBe(200);
  });

  it('fails with a readable message when the port was chosen explicitly', async () => {
    const taken = await blockPort();
    const h = createHarness();
    await expect(listenDashboardServer({ ...deps(h), port: taken, strictPort: true })).rejects.toThrow(
      `Port ${taken} is already in use`,
    );
  });

  it('closes promptly even while a dashboard is connected to the event stream', async () => {
    const h = createHarness();
    const server = await listenDashboardServer({ ...deps(h), port: 0 });
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
