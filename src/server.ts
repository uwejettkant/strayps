import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GuardConfigManager, type GuardMode } from './core/guard-config.js';
import { type MonitoredProcess, ProcessMonitor } from './core/process-monitor.js';
import { RepoWatcher, type WatchActivityEvent } from './core/watcher.js';

export interface WatchdogServerDeps {
  rootDir: string;
  configManager: GuardConfigManager;
  watcher: RepoWatcher;
  processMonitor: ProcessMonitor;
}

export interface DashboardStatusSnapshot {
  rootDir: string;
  config: ReturnType<GuardConfigManager['getConfig']>;
  checkpoint: ReturnType<RepoWatcher['getCheckpoint']>;
  modifiedFiles: string[];
  trippedFiles: string[];
  events: WatchActivityEvent[];
  processes: MonitoredProcess[];
  timestamp: number;
}

function loadDashboardHtml(): string {
  const candidates: string[] = [path.resolve(process.cwd(), 'src/ui/public/index.html')];

  try {
    const baseDir =
      typeof __dirname !== 'undefined'
        ? __dirname
        : path.dirname(fs.realpathSync(process.argv[1] ?? process.cwd()));
    candidates.push(
      path.resolve(baseDir, 'ui/public/index.html'),
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

  return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><title>agent-leash</title></head><body><h1>agent-leash watchdog</h1></body></html>`;
}

export function createWatchdogApp(deps: WatchdogServerDeps) {
  const { rootDir, configManager, watcher, processMonitor } = deps;
  const app = new Hono();
  const sseListeners = new Set<(snapshot: DashboardStatusSnapshot) => void>();
  const extraEvents: WatchActivityEvent[] = [];

  const getStatusSnapshot = (): DashboardStatusSnapshot => {
    const mergedEvents = [...extraEvents, ...watcher.getRecentEvents(80)]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 80);

    return {
      rootDir,
      config: configManager.getConfig(),
      checkpoint: watcher.getCheckpoint(),
      modifiedFiles: watcher.getModifiedFiles(),
      trippedFiles: watcher.loopDetector.getTrippedFiles(),
      events: mergedEvents,
      processes: processMonitor.getProcesses(),
      timestamp: Date.now(),
    };
  };

  const broadcast = () => {
    const snapshot = getStatusSnapshot();
    for (const listener of sseListeners) {
      listener(snapshot);
    }
  };

  // Wire up cross-module reactivity
  watcher.on('file-edit', () => {
    processMonitor.recordFileActivity();
    broadcast();
  });

  watcher.on('activity', () => {
    broadcast();
  });

  processMonitor.on('process-frozen', (proc: MonitoredProcess) => {
    extraEvents.unshift({
      id: `proc-frozen-${proc.pid}-${Date.now()}`,
      type: 'limit-warn',
      message: `${proc.status}: PID ${proc.pid} (${proc.cmd}, ${proc.memoryMb} MB) — ${proc.reason}`,
      severity: proc.status === 'FROZEN' ? 'critical' : 'warn',
      timestamp: Date.now(),
    });
    broadcast();
  });

  processMonitor.on('process-killed', ({ pid }: { pid: number }) => {
    extraEvents.unshift({
      id: `proc-kill-${pid}-${Date.now()}`,
      type: 'rollback',
      message: `Terminated process PID ${pid} via SIGKILL`,
      severity: 'warn',
      timestamp: Date.now(),
    });
    broadcast();
  });

  processMonitor.on('scan-complete', () => {
    broadcast();
  });

  // Serve Single-Page Dashboard
  app.get('/', (c) => {
    return c.html(loadDashboardHtml());
  });

  // REST Status API
  app.get('/api/status', (c) => {
    return c.json(getStatusSnapshot());
  });

  // Switch Guard Mode (strict | balanced | yolo)
  app.post('/api/mode', async (c) => {
    const body = await c.req.json<{ mode?: GuardMode }>().catch(() => ({ mode: undefined }));
    if (!body.mode) {
      return c.json({ error: 'Missing mode parameter' }, 400);
    }
    const updated = configManager.setMode(body.mode, true);
    processMonitor.setSilenceTimeoutSec(updated.limits.mcpSilenceTimeoutSec);
    watcher.loopDetector.setMaxEditsPerFilePerMinute(updated.limits.maxEditsPerFilePerMinute);

    extraEvents.unshift({
      id: `mode-${Date.now()}`,
      type: 'file-edit',
      message: `Guard mode switched to ${updated.mode.toUpperCase()}`,
      severity: 'info',
      timestamp: Date.now(),
    });

    broadcast();
    return c.json({ ok: true, mode: updated.mode, status: getStatusSnapshot() });
  });

  // 1-Click Kill for a specific PID
  app.post('/api/kill/:pid', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0) {
      return c.json({ error: 'Invalid PID' }, 400);
    }
    const killed = processMonitor.killProcess(pid);
    broadcast();
    return c.json({ ok: killed, pid, status: getStatusSnapshot() });
  });

  // Kill all frozen/zombie processes
  app.post('/api/kill-frozen', (c) => {
    const killedPids = processMonitor.killAllMonitored(true);
    broadcast();
    return c.json({ ok: true, killedPids, status: getStatusSnapshot() });
  });

  // Rollback a single file
  app.post('/api/rollback-file', async (c) => {
    const body = await c.req.json<{ filePath?: string }>().catch(() => ({ filePath: undefined }));
    if (!body.filePath) {
      return c.json({ error: 'Missing filePath' }, 400);
    }
    const restored = watcher.rollbackFile(body.filePath);
    watcher.loopDetector.resetFile(body.filePath);
    broadcast();
    return c.json({ ok: restored, filePath: body.filePath, status: getStatusSnapshot() });
  });

  // PANIC ROLLBACK & KILL ALL
  app.post('/api/panic', (c) => {
    const rollbackResult = watcher.panicRollbackAll();
    const killedPids = processMonitor.killAllMonitored(false);
    broadcast();
    return c.json({
      ok: true,
      restoredFiles: rollbackResult.restoredFiles,
      restoredCount: rollbackResult.count,
      killedPids,
      status: getStatusSnapshot(),
    });
  });

  // Live SSE Event Stream
  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      let open = true;
      const sendSnapshot = (snapshot: DashboardStatusSnapshot) => {
        if (!open) return;
        void stream.writeSSE({
          data: JSON.stringify({ type: 'status', status: snapshot }),
        });
      };

      sseListeners.add(sendSnapshot);
      sendSnapshot(getStatusSnapshot());

      stream.onAbort(() => {
        open = false;
        sseListeners.delete(sendSnapshot);
      });

      while (open) {
        await stream.sleep(5000);
        if (open) {
          sendSnapshot(getStatusSnapshot());
        }
      }
    });
  });

  return { app, getStatusSnapshot };
}

export interface StartServerOptions extends WatchdogServerDeps {
  port?: number;
  hostname?: string;
}

export function startWatchdogServer(options: StartServerOptions) {
  const { app } = createWatchdogApp(options);
  const port = options.port ?? 4321;
  const hostname = options.hostname ?? 'localhost';

  const server = serve({
    fetch: app.fetch,
    port,
    ...(options.hostname ? { hostname: options.hostname } : {}),
  });

  return {
    app,
    server,
    port,
    hostname,
    url: `http://${hostname}:${port}`,
  };
}
