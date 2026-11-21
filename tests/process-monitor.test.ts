import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseElapsedTime,
  ProcessMonitor,
  type RawProcessInfo,
} from '../src/core/process-monitor.js';

describe('ProcessMonitor', () => {
  it('lists MCP servers and tracks their CPU activity, but no browser or app that no agent started', async () => {
    let mockProcesses: RawProcessInfo[] = [
      {
        pid: 4101,
        name: 'node',
        cmd: 'node /usr/local/bin/playwright-mcp-server',
        cpu: 12.5,
        memory: 2.1,
      },
      {
        pid: 4102,
        name: 'Chromium',
        cmd: '/Applications/Chromium.app --headless --remote-debugging-port=9222',
        cpu: 0,
        memory: 4.5,
      },
      {
        pid: 9999,
        name: 'Finder',
        cmd: '/System/Library/CoreServices/Finder.app',
        cpu: 0.2,
        memory: 1.0,
      },
    ];

    const t0 = 1_000_000;
    const monitor = new ProcessMonitor({
      rootDir: '/Users/dev/projects/strayps',
      mcpSilenceTimeoutSec: 45,
      selfPid: 1000,
      processLister: async () => mockProcesses,
    });

    const list = await monitor.scan(t0);

    expect(list.map((p) => p.pid)).toEqual([4101]);
    expect(list[0].category).toBe('mcp');
    expect(list[0].status).toBe('ACTIVE');
  });

  it('marks an orphaned MCP process as FROZEN after mcpSilenceTimeoutSec and can terminate it', async () => {
    let mockProcesses: RawProcessInfo[] = [
      {
        pid: 5001,
        ppid: 1,
        pgid: 5000,
        name: 'node',
        cmd: 'npx @playwright/mcp@latest',
        cpu: 0,
        memory: 3.4,
      },
    ];

    const killedPids: number[] = [];
    const onFrozen = vi.fn();
    const onKilled = vi.fn();

    const t0 = 2_000_000;
    const monitor = new ProcessMonitor({
      rootDir: '/Users/dev/projects/strayps',
      mcpSilenceTimeoutSec: 45,
      agentActive: true,
      selfPid: 1000,
      processLister: async () => mockProcesses,
      processKiller: (pid) => {
        killedPids.push(pid);
        mockProcesses = mockProcesses.filter((p) => p.pid !== pid);
        return true;
      },
    });

    monitor.on('process-frozen', onFrozen);
    monitor.on('process-killed', onKilled);

    // Initial scan at t0
    await monitor.scan(t0);
    expect(monitor.getFrozenProcesses()).toHaveLength(0);

    // Scan at t0 + 30s (still below 45s threshold)
    await monitor.scan(t0 + 30_000);
    expect(monitor.getFrozenProcesses()).toHaveLength(0);

    // Scan at t0 + 46s (exceeds 45s silence threshold -> FROZEN!)
    await monitor.scan(t0 + 46_000);
    const frozen = monitor.getFrozenProcesses();
    expect(frozen).toHaveLength(1);
    expect(frozen[0].pid).toBe(5001);
    expect(frozen[0].status).toBe('FROZEN');
    expect(frozen[0].silenceSec).toBe(46);
    expect(onFrozen).toHaveBeenCalledTimes(1);

    // 1-Click Kill
    const killed = monitor.killProcess(5001);
    expect(killed).toBe(true);
    expect(killedPids).toContain(5001);
    expect(onKilled).toHaveBeenCalledTimes(1);
    expect(monitor.getProcesses()).toHaveLength(0);
  });

  it('recovers an orphaned FROZEN process on a CPU heartbeat', async () => {
    const mockProcesses: RawProcessInfo[] = [
      {
        pid: 6001,
        ppid: 1,
        pgid: 6000,
        name: 'node',
        cmd: 'node /x/node_modules/.bin/mcp-server-fetch',
        cpu: 0,
        memory: 2.0,
      },
    ];

    const t0 = 5_000_000;
    const monitor = new ProcessMonitor({
      mcpSilenceTimeoutSec: 45,
      agentActive: true,
      selfPid: 1000,
      processLister: async () => mockProcesses,
    });

    await monitor.scan(t0);
    await monitor.scan(t0 + 50_000);
    expect(monitor.getFrozenProcesses()).toHaveLength(1);

    // its own CPU activity does
    mockProcesses[0].cpu = 3;
    await monitor.scan(t0 + 52_000);
    expect(monitor.getFrozenProcesses()).toHaveLength(0);
  });

  it('monitors multiple simultaneous AI coding agents and MCP servers across repositories', async () => {
    const mockProcesses: RawProcessInfo[] = [
      {
        pid: 62536,
        name: 'claude',
        cmd: '/Users/dev/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude --model=claude-sonnet-5-5 --allowedTools=mcp__computer-use',
        cwd: '/Users/dev/projects/current-app',
        cpu: 4.2,
        memory: 1.3,
      },
      {
        pid: 66817,
        name: 'claude',
        cmd: 'claude',
        cwd: '/Users/dev/projects/current-app',
        cpu: 0.8,
        memory: 0.7,
      },
      {
        pid: 62979,
        name: 'node',
        cmd: 'node /Users/dev/.npm/_npx/15c8/node_modules/.bin/dataforseo-mcp-server',
        cwd: '/Users/dev/projects/current-app',
        cpu: 0.0,
        memory: 0.2,
      },
      {
        pid: 12317,
        name: 'node',
        cmd: 'node /Users/dev/.npm/_npx/15c8/node_modules/.bin/dataforseo-mcp-server',
        cwd: '/Users/dev/projects/old-app',
        cpu: 0.0,
        memory: 0.1,
      },
    ];

    const monitor = new ProcessMonitor({
      rootDir: '/Users/dev/projects/current-app',
      mcpSilenceTimeoutSec: 45,
      selfPid: 1000,
      processLister: async () => mockProcesses,
    });

    const list = await monitor.scan(10_000);
    expect(list).toHaveLength(4);

    const agents = list.filter((p) => p.category === 'agent');
    const mcps = list.filter((p) => p.category === 'mcp');

    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.cmd)).toContain('claude-code (claude-sonnet-5-5)');
    expect(mcps).toHaveLength(2);
  });

  it('parses POSIX elapsed uptime and reports multi-day processes from other repos as STALE with exact RAM in MB', async () => {
    expect(parseElapsedTime('13-19:48:03')).toEqual({
      elapsedSec: 13 * 86400 + 19 * 3600 + 48 * 60 + 3,
      formattedUptime: '13d 19h',
    });
    expect(parseElapsedTime('01:49:20')).toEqual({
      elapsedSec: 1 * 3600 + 49 * 60 + 20,
      formattedUptime: '1h 49m',
    });

    const mockProcesses: RawProcessInfo[] = [
      {
        pid: 11905,
        ppid: 11904,
        name: 'claude',
        cmd: '/Users/dev/Library/Application Support/Claude/claude-code/2.1.308/claude.app/Contents/MacOS/claude --model=claude-sonnet-5-5',
        cwd: '/Users/dev/projects/old-app',
        rssKb: 69308,
        etime: '13-19:48:03',
        cpuTimeSec: 42.5,
        cpu: 0.1,
        memory: 0.4,
      },
      {
        pid: 91585,
        ppid: 1,
        name: 'Claude',
        cmd: '/Applications/Claude.app/Contents/MacOS/Claude',
        rssKb: 124000,
        etime: '14-20:55:13',
        cpu: 4.1,
        memory: 0.8,
      },
    ];

    const monitor = new ProcessMonitor({
      rootDir: '/Users/dev/projects/current-app',
      mcpSilenceTimeoutSec: 45,
      selfPid: 1000,
      staleQuietSec: 0,
      processLister: async () => mockProcesses,
    });

    const list = await monitor.scan(10_000);
    // Main Claude Desktop GUI app (91585) is filtered out; stale agent from the old project (11905) is flagged STALE
    expect(list).toHaveLength(1);
    expect(list[0].pid).toBe(11905);
    expect(list[0].status).toBe('STALE');
    expect(list[0].pauseTarget).toBe(false);
    expect(list[0].memoryMb).toBe(67.7);
    expect(list[0].uptime).toBe('13d 19h');
  });

  it('never marks a long-running (>6h) agent session in the CURRENTLY watched repository as STALE', async () => {
    const mockProcesses: RawProcessInfo[] = [
      {
        pid: 62536,
        ppid: 62163,
        name: 'claude',
        cmd: '/Users/dev/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude',
        cwd: '/Users/dev/projects/current-app',
        rssKb: 198963,
        etime: '06:07:12',
        cpu: 0.0,
        memory: 1.2,
      },
    ];

    const monitor = new ProcessMonitor({
      rootDir: '/Users/dev/projects/current-app',
      mcpSilenceTimeoutSec: 45,
      selfPid: 1000,
      processLister: async () => mockProcesses,
    });

    const list = await monitor.scan(10_000);
    expect(list).toHaveLength(1);
    expect(list[0].status).not.toBe('STALE');
    expect(list[0].pauseTarget).toBe(true);
  });
});

describe('system programs', () => {
  it('runs ps, lsof and footprint by their constant, never by a bare name through PATH', () => {
    // Through PATH, npx and npm scripts run a program of that name from the watched repository's
    // node_modules/.bin. isForegroundProcess still called a bare 'ps' (external audit, 21.11.2026)
    const root = path.join(import.meta.dirname, '..', 'src');
    const files = fs.readdirSync(root, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.ts'));
    const bare = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|exec|execSync)\(\s*['"`](?:ps|lsof|footprint)\b/;
    const offenders = files.filter((f) => bare.test(fs.readFileSync(path.join(root, f), 'utf-8')));
    expect(files.length).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
