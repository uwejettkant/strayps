import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GuardConfigManager } from './core/guard-config.js';
import { ProcessMonitor } from './core/process-monitor.js';
import { type StatusSnapshot, WatchdogSession } from './core/session.js';
import { RepoWatcher } from './core/watcher.js';
import { getVersion } from './version.js';

export interface WatchdogServerDeps {
  rootDir: string;
  configManager: GuardConfigManager;
  watcher: RepoWatcher;
  processMonitor: ProcessMonitor;
  /** Shared session. Pass the one the terminal UI uses so both views stay in sync. */
  session?: WatchdogSession;
  /** Token every state-changing request must carry. Random per server when omitted. */
  token?: string;
  /** Additional host name accepted in the `Host` header besides the loopback names. */
  hostname?: string;
}

/** @deprecated Use `StatusSnapshot` from the session module. Kept for existing imports. */
export type DashboardStatusSnapshot = StatusSnapshot;

export const TOKEN_HEADER = 'x-leash-token';
export const DEFAULT_PORT = 4321;
export const DEFAULT_HOSTNAME = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function loadDashboardHtml(): string {
  const candidates: string[] = [];

  try {
    const baseDir =
      typeof __dirname !== 'undefined'
        ? __dirname
        : path.dirname(fs.realpathSync(process.argv[1] ?? process.cwd()));
    candidates.push(
      // running from source (src/server.ts) or tests
      path.resolve(baseDir, 'ui/public/index.html'),
      // running from the published bundle (dist/*.js next to src/ui/public)
      path.resolve(baseDir, '../src/ui/public/index.html'),
    );
  } catch {
    // Ignore resolution fallback errors
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate, 'utf-8');
      } catch {
        // Try next candidate
      }
    }
  }

  return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><title>agent-leash</title></head><body><h1>agent-leash watchdog</h1><p>Dashboard assets are missing from this installation. The terminal view and the API still work.</p></body></html>`;
}

/** `localhost:4321` -> `localhost`, `[::1]:4321` -> `[::1]` */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function createWatchdogApp(deps: WatchdogServerDeps) {
  const { rootDir, configManager, watcher, processMonitor } = deps;
  const session =
    deps.session ?? new WatchdogSession({ rootDir, configManager, watcher, processMonitor });
  const token = deps.token ?? randomBytes(24).toString('base64url');
  const allowedHosts = new Set(LOOPBACK_HOSTS);
  if (deps.hostname) {
    allowedHosts.add(deps.hostname.toLowerCase());
  }

  const app = new Hono();
  const getStatusSnapshot = (): StatusSnapshot => session.getSnapshot();

  // --- Request guards -------------------------------------------------------------------------

  // The dashboard is a local tool. A request whose Host header names anything but this machine
  // reached us through DNS rebinding (a web page pointing its own domain at 127.0.0.1).
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host && !allowedHosts.has(hostnameOf(host))) {
      return c.json({ error: 'Forbidden: unexpected Host header' }, 403);
    }
    await next();
  });

  // Every endpoint that changes something must come from the dashboard page itself:
  // same origin, and carrying the token that only that page was given.
  const requireDashboardOrigin = (c: Context): Response | null => {
    const host = c.req.header('host');
    const origin = c.req.header('origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = '';
      }
      if (!host || originHost !== host.trim().toLowerCase()) {
        return c.json({ error: 'Forbidden: cross-origin request' }, 403);
      }
    }
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') {
      return c.json({ error: 'Forbidden: cross-site request' }, 403);
    }
    const presented = c.req.header(TOKEN_HEADER);
    if (!presented || !safeEqual(presented, token)) {
      return c.json({ error: 'Forbidden: missing or invalid dashboard token' }, 403);
    }
    return null;
  };

  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const denied = requireDashboardOrigin(c);
      if (denied) return denied;
    }
    await next();
  });

  // --- Routes ---------------------------------------------------------------------------------

  // Serve Single-Page Dashboard
  app.get('/', (c) => {
    const nonce = randomBytes(16).toString('base64');
    const html = loadDashboardHtml()
      .replaceAll('__LEASH_TOKEN__', token)
      .replaceAll('__LEASH_VERSION__', getVersion())
      .replaceAll('__LEASH_NONCE__', nonce);
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // The nonce covers our own inline script. Injected markup (onerror=..., <script>) has none.
        `script-src 'nonce-${nonce}' https://cdn.tailwindcss.com`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    return c.html(html);
  });

  // REST Status API
  app.get('/api/status', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(getStatusSnapshot());
  });


  // 1-Click Kill for a specific monitored PID
  app.post('/api/kill/:pid', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0) {
      return c.json({ error: 'Invalid PID' }, 400);
    }
    const result = session.killProcess(pid);
    if (!result.ok) {
      return c.json({ ok: false, pid, error: result.error, status: getStatusSnapshot() }, 404);
    }
    return c.json({ ok: true, pid, status: getStatusSnapshot() });
  });

  // There is deliberately no bulk "kill everything stale" route: the stale/frozen verdict has been
  // wrong about sessions that were still in use. Processes are terminated one PID at a time.

  // Rollback a single file
  app.post('/api/rollback-file', async (c) => {
    const body = await c.req.json<{ filePath?: unknown }>().catch(() => ({ filePath: undefined }));
    if (typeof body.filePath !== 'string' || body.filePath.length === 0) {
      return c.json({ error: 'Missing filePath' }, 400);
    }
    const restored = session.rollbackFile(body.filePath);
    return c.json({ ok: restored, filePath: body.filePath, status: getStatusSnapshot() });
  });

  // PANIC: stop the agents of the watched repository (and what they started), roll back all files
  app.post('/api/panic', (c) => {
    const result = session.panic();
    return c.json({
      ok: true,
      restoredFiles: result.restoredFiles,
      restoredCount: result.restoredCount,
      skippedFiles: result.skippedFiles,
      killedPids: result.killedPids,
      status: getStatusSnapshot(),
    });
  });

  // Live SSE Event Stream
  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      let open = true;
      const sendSnapshot = (snapshot: StatusSnapshot) => {
        if (!open) return;
        void stream
          .writeSSE({ data: JSON.stringify({ type: 'status', status: snapshot }) })
          .catch(() => {
            open = false;
          });
      };

      session.on('update', sendSnapshot);
      sendSnapshot(getStatusSnapshot());

      stream.onAbort(() => {
        open = false;
        session.off('update', sendSnapshot);
      });

      while (open) {
        await stream.sleep(5000);
        if (open) {
          sendSnapshot(getStatusSnapshot());
        }
      }
      session.off('update', sendSnapshot);
    });
  });

  return { app, getStatusSnapshot, session, token };
}

export interface StartServerOptions extends WatchdogServerDeps {
  port?: number;
}

export interface RunningWatchdogServer {
  app: Hono;
  server: Server;
  session: WatchdogSession;
  token: string;
  port: number;
  hostname: string;
  url: string;
  close: () => Promise<void>;
}

function displayHost(hostname: string): string {
  if (hostname === '127.0.0.1' || hostname === '::1') return 'localhost';
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Open event streams would keep close() waiting forever
    server.closeAllConnections?.();
  });
}

/**
 * Starts the dashboard server and returns immediately.
 *
 * Binds to the loopback interface unless `hostname` says otherwise. Port conflicts surface as an
 * `error` event on the returned server; use `listenWatchdogServer` to await readiness and get
 * automatic fallback to the next free port.
 */
export function startWatchdogServer(options: StartServerOptions) {
  const { app, session, token } = createWatchdogApp(options);
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  const server = serve({ fetch: app.fetch, port, hostname }) as Server;

  return {
    app,
    server,
    session,
    token,
    port,
    hostname,
    url: `http://${displayHost(hostname)}:${port}`,
    close: () => closeServer(server),
  };
}

export interface ListenServerOptions extends StartServerOptions {
  /** Fail instead of trying the next ports when `port` is taken (default: false). */
  strictPort?: boolean;
  /** How many consecutive ports to try (default: 20). */
  maxPortAttempts?: number;
}

/**
 * Starts the dashboard server and resolves once it is accepting connections.
 * If the port is taken, the next ports are tried unless `strictPort` is set.
 */
export async function listenWatchdogServer(
  options: ListenServerOptions,
): Promise<RunningWatchdogServer> {
  const { app, session, token } = createWatchdogApp(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const firstPort = options.port ?? DEFAULT_PORT;
  const attempts = options.strictPort || firstPort === 0 ? 1 : (options.maxPortAttempts ?? 20);

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = firstPort === 0 ? 0 : firstPort + i;
    if (port > 65535) break;
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const candidate = serve({ fetch: app.fetch, port, hostname }) as Server;
        candidate.once('error', reject);
        candidate.once('listening', () => {
          candidate.off('error', reject);
          resolve(candidate);
        });
      });
      // From here on a server error must not take the watchdog down
      server.on('error', () => {});
      const actualPort = (server.address() as AddressInfo | null)?.port ?? port;
      return {
        app,
        server,
        session,
        token,
        port: actualPort,
        hostname,
        url: `http://${displayHost(hostname)}:${actualPort}`,
        close: () => closeServer(server),
      };
    } catch (err) {
      lastError = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }

  const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    const range =
      attempts > 1 ? `Ports ${firstPort}-${firstPort + attempts - 1} are` : `Port ${firstPort} is`;
    throw new Error(`${range} already in use. Pick another one with --port <port>.`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
