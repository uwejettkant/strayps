import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ConfigManager } from './core/config.js';
import { ProcessMonitor } from './core/process-monitor.js';
import { type StatusSnapshot, MonitorSession } from './core/session.js';
import { getVersion } from './version.js';

/** Dashboard tabs that may stream at the same time. */
const MAX_EVENT_STREAMS = 16;

export interface DashboardServerDeps {
  rootDir: string;
  configManager: ConfigManager;
  processMonitor: ProcessMonitor;
  /** Shared session. Pass the one the terminal UI uses so both views stay in sync. */
  session?: MonitorSession;
  /** Additional host name accepted in the `Host` header besides the loopback names. */
  hostname?: string;
}

/** @deprecated Use `StatusSnapshot` from the session module. Kept for existing imports. */
export type DashboardStatusSnapshot = StatusSnapshot;

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOSTNAME = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Reads a file of the dashboard from the installation, never from the working directory. */
function loadDashboardAsset(name: string): string | null {
  const candidates: string[] = [];

  try {
    const baseDir =
      typeof __dirname !== 'undefined'
        ? __dirname
        : path.dirname(fs.realpathSync(process.argv[1] ?? process.cwd()));
    candidates.push(
      // running from source (src/server.ts) or tests
      path.resolve(baseDir, 'ui/public', name),
      // running from the published bundle (dist/*.js next to src/ui/public)
      path.resolve(baseDir, '../src/ui/public', name),
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
  return null;
}

function loadDashboardHtml(): string {
  const html = loadDashboardAsset('index.html');
  if (html !== null) return html;
  return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><title>strayps</title></head><body><h1>strayps</h1><p>Dashboard assets are missing from this installation. The terminal view and the API still work.</p></body></html>`;
}

/**
 * A browser says where a request comes from. Without the header (curl, a script) or typed into the
 * address bar ("none"), the request is local; from another site it is refused.
 */
function isCrossSite(fetchSite: string | undefined): boolean {
  return Boolean(fetchSite) && fetchSite !== 'same-origin' && fetchSite !== 'none';
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

export function createDashboardApp(deps: DashboardServerDeps) {
  const { rootDir, configManager, processMonitor } = deps;
  const session = deps.session ?? new MonitorSession({ rootDir, configManager, processMonitor });
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

  // A read-only server: no route changes anything. Ending processes and pausing run in the
  // terminal, where they ask first; a page any local process can load once held the token for
  // the kill route.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      c.header('Allow', 'GET, HEAD');
      return c.json({ error: 'This dashboard is read-only; use the terminal to end or pause processes' }, 405);
    }
    await next();
  });

  // --- Routes ---------------------------------------------------------------------------------

  // Serve Single-Page Dashboard
  app.get('/', (c) => {
    const nonce = randomBytes(16).toString('base64');
    const html = loadDashboardHtml()
      .replaceAll('__STRAYPS_VERSION__', getVersion())
      .replaceAll('__STRAYPS_NONCE__', nonce);
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // The nonce covers our own inline script. Injected markup (onerror=..., <script>) has none.
        `script-src 'nonce-${nonce}'`,
        // Our stylesheet and our one nonce-marked <style>; injected <style> markup has no nonce.
        `style-src 'self' 'nonce-${nonce}'`,
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

  // Styles generated at build time from the page's classes: nothing is loaded from another host
  app.get('/dashboard.css', (c) => {
    const css = loadDashboardAsset('dashboard.css');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    if (css === null) return c.text('/* dashboard styles are missing from this installation */', 404);
    return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  // REST Status API
  app.get('/api/status', (c) => {
    // Another site cannot read the answer (no CORS headers), but it need not get one either
    if (isCrossSite(c.req.header('sec-fetch-site'))) return c.json({ error: 'Forbidden: cross-site request' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    return c.json(getStatusSnapshot());
  });


  // Live SSE Event Stream
  // The stream is read-only, but every open one holds a listener: a page in another tab could
  // open hundreds. Only the dashboard's own origin may connect, and only a few at a time. When all
  // places are taken, the oldest stream is closed instead of refusing the new one: refusing let
  // any local process that held the places lock the dashboard out.
  const openStreams = new Set<() => void>();
  session.setMaxListeners(MAX_EVENT_STREAMS + 10);
  app.get('/api/events', (c) => {
    if (isCrossSite(c.req.header('sec-fetch-site'))) {
      return c.json({ error: 'Forbidden: cross-site request' }, 403);
    }
    return streamSSE(c, async (stream) => {
      let open = true;
      const close = () => {
        open = false;
        session.off('update', sendSnapshot);
        openStreams.delete(close);
        void stream.close();
      };
      const release = () => {
        openStreams.delete(close);
      };
      if (openStreams.size >= MAX_EVENT_STREAMS) {
        const oldest = openStreams.values().next().value;
        oldest?.();
      }
      openStreams.add(close);
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
        release();
      });

      while (open) {
        await stream.sleep(5000);
        if (open) {
          sendSnapshot(getStatusSnapshot());
        }
      }
      session.off('update', sendSnapshot);
      release();
    });
  });

  return { app, getStatusSnapshot, session };
}

export interface StartServerOptions extends DashboardServerDeps {
  port?: number;
}

export interface RunningDashboardServer {
  app: Hono;
  server: Server;
  session: MonitorSession;
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
 * `error` event on the returned server; use `listenDashboardServer` to await readiness and get
 * automatic fallback to the next free port.
 */
export function startDashboardServer(options: StartServerOptions) {
  const { app, session } = createDashboardApp(options);
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  const server = serve({ fetch: app.fetch, port, hostname }) as Server;

  return {
    app,
    server,
    session,
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
export async function listenDashboardServer(
  options: ListenServerOptions,
): Promise<RunningDashboardServer> {
  const { app, session } = createDashboardApp(options);
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
      // From here on a server error must not take strayps down
      server.on('error', () => {});
      const actualPort = (server.address() as AddressInfo | null)?.port ?? port;
      return {
        app,
        server,
        session,
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
