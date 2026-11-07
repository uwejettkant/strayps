#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import {
  CONFIG_FILENAME,
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  type GuardMode,
  normalizeMode,
} from './core/guard-config.js';
import { LoopDetector } from './core/loop-detector.js';
import { ProcessMonitor } from './core/process-monitor.js';
import { RepoWatcher } from './core/watcher.js';
import { createWatchdogApp, startWatchdogServer } from './server.js';

export {
  CONFIG_FILENAME,
  createWatchdogApp,
  DEFAULT_GUARD_CONFIG,
  GuardConfigManager,
  LoopDetector,
  normalizeMode,
  ProcessMonitor,
  RepoWatcher,
  startWatchdogServer,
};

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('agent-leash')
    .description('The AI Agent & MCP Watchdog for local repositories')
    .version('0.1.0');

  program
    .command('watch', { isDefault: true })
    .description('Watch a repository for agent thrashing, protected file edits, and frozen MCPs')
    .argument('[dir]', 'Target repository directory', '.')
    .option('-p, --port <port>', 'Port for the local web dashboard', '4321')
    .option('-m, --mode <mode>', 'Override guard mode (strict | balanced | yolo)')
    .option('--no-auto-rollback', 'Disable automatic git/snapshot rollback on loop or protected file')
    .option('--demo', 'Run with simulated rogue AI agent & frozen MCP activity (safe, never touches disk)')
    .action(
      async (
        dir: string,
        options: { port: string; mode?: GuardMode; autoRollback?: boolean; demo?: boolean },
      ) => {
        const rootDir = path.resolve(process.cwd(), dir);
        const port = Number(options.port) || 4321;

        const configManager = new GuardConfigManager(
          rootDir,
          options.mode ? { mode: normalizeMode(options.mode) } : undefined,
        );
        const cfg = configManager.getConfig();

        const loopDetector = new LoopDetector({
          maxEditsPerFilePerMinute: cfg.limits.maxEditsPerFilePerMinute,
        });

        const watcher = new RepoWatcher({
          rootDir,
          configManager,
          loopDetector,
          autoRollbackOnLoop: options.demo ? false : options.autoRollback !== false,
          autoRollbackProtected: options.demo ? false : options.autoRollback !== false,
        });

        const demoProcesses = [
          {
            pid: 48210,
            name: 'mcp-server-fs',
            cmd: 'npx @modelcontextprotocol/server-filesystem .',
            cpu: 0,
            memory: 4.8,
          },
          {
            pid: 48244,
            name: 'mcp-server-git',
            cmd: 'node ./node_modules/.bin/mcp-server-git --stdio',
            cpu: 14.2,
            memory: 6.1,
          },
        ];

        const processMonitor = new ProcessMonitor({
          rootDir,
          mcpSilenceTimeoutSec: cfg.limits.mcpSilenceTimeoutSec,
          pollIntervalMs: 2000,
          ...(options.demo
            ? {
                processLister: async () => demoProcesses,
                processKiller: (pid: number) => {
                  const idx = demoProcesses.findIndex((p) => p.pid === pid);
                  if (idx !== -1) {
                    demoProcesses.splice(idx, 1);
                    return true;
                  }
                  return false;
                },
              }
            : {}),
        });

        const checkpoint = await watcher.start();
        processMonitor.start();

        if (options.demo) {
          // Simulate a realistic 10-second sequence of agent edits, .env breach, loop & frozen MCP
          const t0 = Date.now();
          setTimeout(() => watcher.handleFileSystemEvent('change', 'src/api/client.ts'), 1200);
          setTimeout(() => watcher.handleFileSystemEvent('change', '.env.local'), 2600);
          for (let i = 1; i <= 6; i++) {
            setTimeout(() => {
              watcher.handleFileSystemEvent('change', 'src/auth/session.ts');
            }, 3500 + i * 450);
          }
          setTimeout(() => {
            void processMonitor.scan(t0 + (cfg.limits.mcpSilenceTimeoutSec + 5) * 1000);
          }, 7000);
        }

        const { url, server } = startWatchdogServer({
          rootDir,
          configManager,
          watcher,
          processMonitor,
          port,
        });

        console.log(`\n┌──────────────────────────────────────────────────────────┐`);
        console.log(`│  agent-leash v0.1.0 — AI Agent & MCP Watchdog            │`);
        console.log(`└──────────────────────────────────────────────────────────┘`);
        console.log(`  Repo:        ${rootDir}`);
        console.log(`  Mode:        ${cfg.mode.toUpperCase()}`);
        console.log(`  Checkpoint:  ${checkpoint.ref} (${checkpoint.type}, ${checkpoint.snapshottedFiles} files)`);
        console.log(`  Dashboard:   ${url}`);
        console.log(`  Limits:      warn=${cfg.limits.maxFilesWarn}, stop=${cfg.limits.maxFilesHardStop}, loop=${cfg.limits.maxEditsPerFilePerMinute}/min, mcp=${cfg.limits.mcpSilenceTimeoutSec}s\n`);

        watcher.on('protected-file', (ev) => {
          console.warn(`[PROTECTED] ${ev.message}`);
        });

        watcher.on('loop-detected', (alert) => {
          console.error(
            `[CIRCUIT BREAKER] Thrashing detected on ${alert.filePath} (${alert.editCount} edits/min)!`,
          );
        });

        processMonitor.on('process-frozen', (proc) => {
          console.warn(
            `[${proc.status}] PID ${proc.pid} (${proc.cmd}, ${proc.memoryMb} MB) — ${proc.reason}`,
          );
        });

        const shutdown = async () => {
          console.log('\nShutting down agent-leash watchdog...');
          processMonitor.stop();
          await watcher.stop();
          server.close();
          process.exit(0);
        };

        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      },
    );

  program
    .command('status')
    .description('Print a live terminal table of active, standby, and stale agent/MCP processes')
    .argument('[dir]', 'Target repository directory', '.')
    .action(async (dir: string) => {
      const rootDir = path.resolve(process.cwd(), dir);
      const configManager = new GuardConfigManager(rootDir);
      const cfg = configManager.getConfig();
      const monitor = new ProcessMonitor({
        rootDir,
        mcpSilenceTimeoutSec: cfg.limits.mcpSilenceTimeoutSec,
      });

      const procs = await monitor.scan();
      const stale = procs.filter((p) => p.safety === 'safe-to-kill');
      const reclaimableMb = stale.reduce((sum, p) => sum + p.memoryMb, 0);
      const totalMb = procs.reduce((sum, p) => sum + p.memoryMb, 0);

      console.log(`\n┌────────────────────────────────────────────────────────────────────────────┐`);
      console.log(`│  agent-leash status — ${rootDir.slice(-50).padEnd(50)} │`);
      console.log(`└────────────────────────────────────────────────────────────────────────────┘`);
      console.log(
        `  Mode: ${cfg.mode.toUpperCase()}  |  Processes: ${procs.length} (${ totalMb.toFixed(1)} MB)  |  Reclaimable: ${stale.length} (${reclaimableMb.toFixed(1)} MB)\n`,
      );
      console.log(
        `  ${'PID'.padEnd(7)} ${'STATUS'.padEnd(9)} ${'SAFETY'.padEnd(14)} ${'RAM'.padStart(9)} ${'AGE'.padStart(9)}  ${'COMMAND / CWD'}`,
      );
      console.log(`  ${'─'.repeat(74)}`);
      for (const p of procs) {
        const cwdSuffix = p.cwd ? ` [${p.cwd}]` : '';
        console.log(
          `  ${String(p.pid).padEnd(7)} ${p.status.padEnd(9)} ${p.safety.padEnd(14)} ${(p.memoryMb.toFixed(1) + ' MB').padStart(9)} ${p.uptime.padStart(9)}  ${p.cmd}${cwdSuffix}`,
        );
      }
      console.log('');
    });

  program
    .command('init')
    .description('Create a default .agentguard.json configuration file in the target repository')
    .argument('[dir]', 'Target repository directory', '.')
    .option('-m, --mode <mode>', 'Initial guard mode (strict | balanced | yolo)', 'balanced')
    .action((dir: string, options: { mode: string }) => {
      const rootDir = path.resolve(process.cwd(), dir);
      const manager = new GuardConfigManager(rootDir, {
        mode: normalizeMode(options.mode),
      });
      const writtenPath = manager.saveConfig();
      console.log(`Created ${writtenPath} with mode="${manager.getConfig().mode}".`);
    });

  return program;
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith('cli.ts') ||
    process.argv[1].endsWith('cli.js') ||
    process.argv[1].endsWith('agent-leash'));

if (isDirectExecution) {
  const program = createCliProgram();
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error('agent-leash error:', err);
    process.exit(1);
  });
}
