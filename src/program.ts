import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  CONFIG_FILENAME,
  CONFIG_KEY_INFO,
  CONFIG_KEYS,
  type ConfigKey,
  GuardConfigManager,
  type GuardLimits,
  parseConfigValue,
  resolveConfigKey,
  writeConfigValue,
} from './core/guard-config.js';
import type { ActivityEventType } from './core/events.js';
import { ProcessMonitor, type RawProcessInfo } from './core/process-monitor.js';
import { WatchdogSession } from './core/session.js';
import { DEFAULT_PORT, listenWatchdogServer, type RunningWatchdogServer } from './server.js';
import {
  createPalette,
  formatClock,
  formatStatusReport,
  type Palette,
  sanitize,
  shouldUseColor,
  supportsTruecolor,
  tildify,
} from './ui/format.js';
import { PlainReporter } from './ui/plain.js';
import { TerminalUI } from './ui/terminal.js';
import { getVersion } from './version.js';

/** An error the user caused and can fix; printed without a stack trace, exit code 1. */
export class CliError extends Error {}

interface WatchOptions {
  port?: string;
  demo?: boolean;
  tui?: boolean;
  dashboard?: boolean;
  quiet?: boolean;
}

function resolveTargetDir(dir: string): string {
  const rootDir = path.resolve(process.cwd(), dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(rootDir);
  } catch {
    throw new CliError(`Directory not found: ${rootDir}`);
  }
  if (!stat.isDirectory()) {
    throw new CliError(`Not a directory: ${rootDir}`);
  }
  return rootDir;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > 65535) {
    throw new CliError(`Invalid --port "${raw}": expected a number between 0 and 65535`);
  }
  return Number(raw);
}

/**
 * A full-screen UI needs the terminal for itself: a background job that touches the
 * terminal settings or reads from it gets stopped by the shell (SIGTTOU / SIGTTIN).
 * `ps` marks members of the foreground process group with "+".
 */
function isForegroundProcess(): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(process.pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return stat.includes('+');
  } catch {
    return true;
  }
}

/** Believable sample processes for `--demo`: one of each classification. */
function createDemoProcesses(rootDir: string): RawProcessInfo[] {
  const otherRepo = path.join(os.homedir(), 'projects', 'old-shop');
  return [
    {
      pid: 48110,
      name: 'claude',
      cmd: 'claude --model claude-sonnet-5-5',
      cwd: rootDir,
      cpu: 6.4,
      rssKb: 231_400,
      etime: '12:31',
    },
    {
      pid: 48244,
      ppid: 48110,
      name: 'node',
      cmd: 'node ./node_modules/.bin/mcp-server-git --stdio',
      cwd: rootDir,
      cpu: 14.2,
      rssKb: 62_100,
      etime: '12:29',
    },
    {
      pid: 48210,
      ppid: 48110,
      name: 'node',
      cmd: 'npx @modelcontextprotocol/server-filesystem .',
      cwd: rootDir,
      cpu: 0,
      rssKb: 48_300,
      etime: '12:29',
    },
    {
      pid: 31877,
      name: 'claude',
      cmd: 'claude --model claude-sonnet-5-5',
      cwd: otherRepo,
      cpu: 0,
      // its CPU time does not move: after ten minutes of the demo it is called stale
      cpuTimeSec: 95.2,
      rssKb: 128_500,
      etime: '11-19:42:10',
    },
    {
      pid: 31902,
      ppid: 1,
      // its process group lost its leader: an orphan, not an app started by launchd
      pgid: 31890,
      name: 'node',
      cmd: 'node /Users/demo/.npm/_npx/15c8/node_modules/.bin/dataforseo-mcp-server',
      cpu: 0,
      rssKb: 18_200,
      etime: '11-19:42:01',
    },
  ];
}

function summaryLines(
  session: WatchdogSession,
  startedAt: number,
  palette: Palette,
): string[] {
  const counters = session.getCounters();
  const n = (type: ActivityEventType) => counters[type] ?? 0;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const duration =
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
  const snapshot = session.getSnapshot();
  const lines = [
    `${palette.accent('agent-leash')} stopped after ${duration} — ${sanitize(tildify(session.rootDir))}`,
    `  ${n('process-alert')} process alerts · ${n('process-killed')} processes terminated`,
  ];
  const alerts = snapshot.events.filter((e) => e.severity !== 'info').slice(0, 5).reverse();
  if (alerts.length > 0) {
    lines.push('  Last alerts:');
    for (const event of alerts) {
      const style = event.severity === 'critical' ? palette.danger : palette.warn;
      lines.push(`    ${palette.dim(formatClock(event.timestamp))}  ${style(sanitize(event.message))}`);
    }
  }
  return lines;
}

async function runWatch(dir: string, options: WatchOptions): Promise<void> {
  const rootDir = resolveTargetDir(dir);
  const requestedPort = parsePort(options.port);
  const demo = Boolean(options.demo);
  const startedAt = Date.now();

  // The demo never writes, not even the config file
  const configManager = new GuardConfigManager(rootDir, undefined, { readOnly: demo });
  const cfg = configManager.getConfig();

  let demoProcesses = demo ? createDemoProcesses(rootDir) : [];
  const processMonitor = new ProcessMonitor({
    rootDir,
    mcpSilenceTimeoutSec: cfg.limits.mcpSilenceTimeoutSec,
    staleSessionHours: cfg.limits.staleSessionHours,
    agentNames: cfg.agents,
    pollIntervalMs: 2000,
    ...(demo
      ? {
          processLister: async () => demoProcesses,
          processKiller: (pid: number, signal?: NodeJS.Signals) => {
            // pause and resume only hold and continue; the demo process stays in the list
            if (signal === 'SIGSTOP' || signal === 'SIGCONT') {
              return demoProcesses.some((p) => p.pid === pid);
            }
            const before = demoProcesses.length;
            demoProcesses = demoProcesses.filter((p) => p.pid !== pid);
            return demoProcesses.length < before;
          },
          processAlive: () => false,
          // The demo's own numbers as the footprint: footprint must never inspect a made-up PID
          memoryReader: async (pids: number[]) =>
            new Map(
              demoProcesses
                .filter((p) => pids.includes(p.pid) && p.rssKb !== undefined)
                .map((p) => [p.pid, p.rssKb! * 1024]),
            ),
        }
      : {}),
  });

  const session = new WatchdogSession({ rootDir, configManager, processMonitor });
  session.addEvent({ type: 'monitor-started', message: `Watching the agent and MCP processes of this machine; current repository ${tildify(rootDir)}`, severity: 'info' });
  processMonitor.start();
  // Edits to .agentguard.json apply to the running watchdog
  session.watchConfigFile();

  let running: RunningWatchdogServer | null = null;
  if (options.dashboard !== false) {
    try {
      running = await listenWatchdogServer({
        rootDir,
        configManager,
        processMonitor,
        session,
        port: requestedPort ?? DEFAULT_PORT,
        // An explicitly chosen port is a decision; only the default one may move.
        strictPort: requestedPort !== undefined,
      });
    } catch (err) {
      processMonitor.stop();
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
  }

  const color = shouldUseColor(process.stdout);
  const palette = createPalette(color, supportsTruecolor());
  const wantsTui =
    options.tui !== false &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    process.env.TERM !== 'dumb';
  const foreground = Boolean(process.stdin.isTTY) ? isForegroundProcess() : true;
  const interactive = wantsTui && foreground;

  let ui: TerminalUI | null = null;
  let reporter: PlainReporter | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number = 0): Promise<void> => {
    if (shuttingDown) {
      // A second request while cleaning up: stop waiting
      ui?.stop();
      process.exit(exitCode === 0 ? 130 : exitCode);
    }
    shuttingDown = true;
    ui?.stop();
    reporter?.stop();
    if (!interactive) {
      process.stdout.write(`\nShutting down agent-leash watchdog (${reason})...\n`);
    }
    processMonitor.stop();
    const within = <T>(work: Promise<T>, ms: number) =>
      Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
    if (running) {
      await within(running.close(), 1500);
    }
    const summary = summaryLines(session, startedAt, palette).join('\n');
    session.dispose();
    process.stdout.write(`${summary}\n`, () => process.exit(exitCode));
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Ctrl+\ in plain mode: its default action ends the process without the exit event, which
  // would leave paused agents stopped
  process.on('SIGQUIT', () => void shutdown('SIGQUIT'));

  // Whatever happens, never leave the terminal in raw mode on the alternate screen
  process.on('exit', () => ui?.stop());
  const crash = (err: unknown) => {
    ui?.stop();
    process.stderr.write(`agent-leash crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  if (interactive) {
    ui = new TerminalUI({
      session,
      stdin: process.stdin,
      stdout: process.stdout,
      version: getVersion(),
      dashboardUrl: running?.url ?? null,
      demo,
      color,
      truecolor: supportsTruecolor(),
      onExit: (reason) => void shutdown(reason),
    });
    for (const warning of configManager.getWarnings()) {
      session.addEvent({ type: 'config-reload', message: `${CONFIG_FILENAME}: ${warning}`, severity: 'warn' });
    }
    ui.start();
    return;
  }

  // --- Plain output: pipes, logs, background jobs, --no-tui ---
  // Commands are read from a pipe, or from the terminal when we own it (foreground).
  const readsInput = !process.stdin.isTTY || foreground;
  const out = (line: string) => process.stdout.write(`${line}\n`);

  out('');
  out(`${palette.accent(`agent-leash v${getVersion()}`)} — AI Agent & MCP Watchdog${demo ? palette.warn('  [DEMO: simulated, nothing is touched]') : ''}`);
  out(`  Repo:        ${sanitize(rootDir)}`);
  out(`  Dashboard:   ${running ? running.url : 'off (--no-dashboard)'}`);
  out(`  Limits:      stale after ${cfg.limits.staleSessionHours}h idle in another repository, frozen after ${cfg.limits.mcpSilenceTimeoutSec}s as an orphan`);
  if (requestedPort === undefined && running && running.port !== DEFAULT_PORT) {
    out(palette.warn(`  Note:        port ${DEFAULT_PORT} was taken, using ${running.port}`));
  }
  for (const warning of configManager.getWarnings()) {
    // Warnings quote keys and values from the file, which the watched agent can write
    out(palette.warn(`  Config:      ${CONFIG_FILENAME}: ${sanitize(warning)}`));
  }
  if (wantsTui && !foreground) {
    out(palette.dim('  Running as a background job: live view and commands are off, stop with "kill -TERM".'));
  } else if (readsInput) {
    out(palette.dim('  Commands:    type "help" and press Enter; "exit" stops the watchdog.'));
  }
  out('');

  reporter = new PlainReporter({
    session,
    write: out,
    input: readsInput ? process.stdin : undefined,
    quiet: Boolean(options.quiet),
    color,
    width: process.stdout.columns ?? 120,
    onExit: (reason) => void shutdown(reason),
  });
  reporter.start();
}

async function runStatus(dir: string): Promise<void> {
  const rootDir = resolveTargetDir(dir);
  const configManager = new GuardConfigManager(rootDir, undefined, { readOnly: true });
  const { limits, agents } = configManager.getConfig();
  const processMonitor = new ProcessMonitor({
    rootDir,
    mcpSilenceTimeoutSec: limits.mcpSilenceTimeoutSec,
    staleSessionHours: limits.staleSessionHours,
    agentNames: agents,
  });
  const session = new WatchdogSession({ rootDir, configManager, processMonitor });
  await processMonitor.scan();

  const palette = createPalette(shouldUseColor(process.stdout), supportsTruecolor());
  const snapshot = session.getSnapshot();
  const width = process.stdout.columns ?? 120;
  const report = formatStatusReport(snapshot, palette, width);

  process.stdout.write(`\n${palette.accent('agent-leash status')}\n${report.join('\n')}\n\n`);
  session.dispose();
}

/** A value for the terminal; it may come from `.agentguard.json`, so it is untrusted text. */
function displayValue(value: unknown): string {
  return sanitize(Array.isArray(value) ? value.join(', ') : String(value));
}

function effectiveValue(manager: GuardConfigManager, key: ConfigKey): string {
  const config = manager.getConfig();
  const list = (values: string[]) => (values.length > 0 ? values.join(', ') : 'none');
  if (key === 'agents') return list(config.agents);
  return String(config.limits[key.slice('limits.'.length) as keyof GuardLimits]);
}

function runConfigShow(dir: string): void {
  const rootDir = resolveTargetDir(dir);
  const manager = new GuardConfigManager(rootDir, undefined, { readOnly: true });
  const palette = createPalette(shouldUseColor(process.stdout), supportsTruecolor());
  const sources = manager.getSources();
  const lines: string[] = [
    '',
    `${palette.accent('agent-leash config')} — ${sanitize(tildify(rootDir))}`,
    manager.hasConfigFile()
      ? `  ${CONFIG_FILENAME} found; values marked (file) come from it, all others are built-in defaults.`
      : `  No ${CONFIG_FILENAME} here; every value is a built-in default.`,
    '',
  ];
  for (const key of CONFIG_KEYS) {
    const source = sources[key];
    const sourceLabel = source === 'default' ? palette.dim('(default)') : palette.ok(`(${source})`);
    lines.push(`  ${palette.strong(key)} = ${palette.accent(sanitize(effectiveValue(manager, key)))}  ${sourceLabel}`);
    lines.push(`      ${palette.dim(CONFIG_KEY_INFO[key])}`);
  }
  const warnings = manager.getWarnings();
  if (warnings.length > 0) {
    lines.push('', palette.warn(`  Problems in ${CONFIG_FILENAME}:`));
    for (const warning of warnings) lines.push(palette.warn(`    - ${sanitize(warning)}`));
  }
  lines.push(
    '',
    `  Change a value:    agent-leash config set staleSessionHours 12`,
    `  Back to default:   agent-leash config unset staleSessionHours`,
    `  Edits to the file, by hand or with these commands, apply to a running agent-leash within a second.`,
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function requireConfigKey(input: string): ConfigKey {
  const key = resolveConfigKey(input);
  if (!key) {
    throw new CliError(`Unknown setting "${input}". Known settings: ${CONFIG_KEYS.join(', ')}`);
  }
  return key;
}

function writeOrFail(rootDir: string, key: ConfigKey, value: number | string[] | undefined) {
  try {
    return writeConfigValue(rootDir, key, value);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
}

function reportConfigProblems(rootDir: string): void {
  const warnings = new GuardConfigManager(rootDir, undefined, { readOnly: true }).getWarnings();
  for (const warning of warnings) {
    process.stdout.write(`  Note: ${sanitize(warning)}\n`);
  }
}

function runConfigSet(rawKey: string, rawValue: string, dir: string): void {
  const rootDir = resolveTargetDir(dir);
  const key = requireConfigKey(rawKey);
  const parsed = parseConfigValue(key, rawValue);
  if (!parsed.ok) {
    throw new CliError(parsed.error);
  }
  const result = writeOrFail(rootDir, key, parsed.value);
  const was = result.previous !== undefined ? ` (was ${displayValue(result.previous)})` : '';
  process.stdout.write(
    `${result.created ? 'Created' : 'Updated'} ${tildify(result.filePath)}: ${key} = ${displayValue(parsed.value)}${was}\n`,
  );
  reportConfigProblems(rootDir);
  process.stdout.write('A running agent-leash picks this up within a second.\n');
}

function runConfigUnset(rawKey: string, dir: string): void {
  const rootDir = resolveTargetDir(dir);
  const key = requireConfigKey(rawKey);
  const result = writeOrFail(rootDir, key, undefined);
  const fallback = sanitize(effectiveValue(new GuardConfigManager(rootDir, undefined, { readOnly: true }), key));
  if (!result.changed) {
    process.stdout.write(`${key} is not set in ${CONFIG_FILENAME}; the default (${fallback}) already applies.\n`);
    return;
  }
  process.stdout.write(`Removed ${key} from ${tildify(result.filePath)}; the default (${fallback}) applies now.\n`);
  reportConfigProblems(rootDir);
}

function runInit(dir: string, options: { force?: boolean }): void {
  const rootDir = resolveTargetDir(dir);
  const target = path.join(rootDir, CONFIG_FILENAME);
  if (fs.existsSync(target) && !options.force) {
    throw new CliError(`${target} already exists. Edit it, or pass --force to replace it with the defaults.`);
  }
  if (options.force && fs.existsSync(target)) {
    fs.rmSync(target);
  }
  const manager = new GuardConfigManager(rootDir);
  const writtenPath = manager.saveConfig();
  process.stdout.write(`Created ${writtenPath} with the default settings.\n`);
}

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('agent-leash')
    .description('The AI Agent & MCP Watchdog for local repositories')
    .version(getVersion());

  program
    .command('watch', { isDefault: true })
    .description('Show the agent and MCP processes of this machine live, and end the ones left behind')
    .argument('[dir]', 'Current repository (its agents are the ones pause holds)', '.')
    .option('-p, --port <port>', `Port for the local web dashboard (default: ${DEFAULT_PORT}, next free port if taken)`)
    .option('--no-tui', 'Plain log output instead of the full-screen terminal view')
    .option('--no-dashboard', 'Do not start the local web dashboard')
    .option('-q, --quiet', 'Plain output only: print warnings and critical events only')
    .option('--demo', 'Simulated agent sessions and stale processes; reaches no real process')
    .action((dir: string, options: WatchOptions) => runWatch(dir, options));

  program
    .command('status')
    .description('Print a one-time table of active, standby, and stale agent/MCP processes')
    .argument('[dir]', 'Target repository directory', '.')
    .action((dir: string) => runStatus(dir));

  program
    .command('init')
    .description('Create a default .agentguard.json configuration file in the target repository')
    .argument('[dir]', 'Target repository directory', '.')
    .option('-f, --force', 'Replace an existing .agentguard.json')
    .action((dir: string, options: { force?: boolean }) => runInit(dir, options));

  const config = program
    .command('config')
    .description('Show or change the settings in .agentguard.json');

  config
    .command('show', { isDefault: true })
    .description('Show every setting, its value, where it comes from and what it does')
    .argument('[dir]', 'Target repository directory', '.')
    .action((dir: string) => runConfigShow(dir));

  config
    .command('set')
    .description('Set one value in .agentguard.json (the file is created if missing)')
    .argument('<key>', 'Setting, e.g. limits.staleSessionHours, staleSessionHours or agents')
    .argument('<value>', 'New value; agents takes program names separated by commas')
    .option('-C, --dir <dir>', 'Target repository directory', '.')
    .action((key: string, value: string, options: { dir: string }) => runConfigSet(key, value, options.dir));

  config
    .command('unset')
    .description('Remove one value from .agentguard.json, so the built-in default applies')
    .argument('<key>', 'Setting, e.g. limits.staleSessionHours')
    .option('-C, --dir <dir>', 'Target repository directory', '.')
    .action((key: string, options: { dir: string }) => runConfigUnset(key, options.dir));

  return program;
}

/** Entry point of the `agent-leash` binary. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await createCliProgram().parseAsync(argv);
  } catch (err) {
    if (err instanceof CliError) {
      // Messages can quote .agentguard.json (V8 parse errors include its text): untrusted
      process.stderr.write(`agent-leash: ${sanitize(err.message)}\n`);
    } else {
      process.stderr.write(
        `agent-leash error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    }
    process.exit(1);
  }
}
