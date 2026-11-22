import { describe, expect, it } from 'vitest';
import {
  classifyStatus,
  type ClassifyLimits,
  type ProcessFacts,
  STALE_CPU_BUDGET_SEC,
  STALE_QUIET_SEC,
} from '../src/core/processes/classify.js';

const limits: ClassifyLimits = {
  staleSessionSec: 6 * 3600,
  staleQuietSec: STALE_QUIET_SEC,
  mcpSilenceTimeoutSec: 45,
  agentActive: true,
};

/** An old session in another repository, watched for the whole window and idle in it. */
const facts = (extra: Partial<ProcessFacts> = {}): ProcessFacts => ({
  pid: 500,
  ppid: 400,
  pgid: 500,
  cmd: 'claude',
  category: 'agent',
  cwd: '/work/other',
  displayCwd: '/work/other',
  belongsToWatchedRepo: false,
  hasLiveParentChain: true,
  elapsedSec: 7 * 3600,
  formattedUptime: '7h 0m',
  hasCpuActivity: false,
  cpuTimeSec: 100,
  usedInWindowSec: 1,
  silenceSec: 600,
  paused: false,
  ...extra,
});

describe('process status rules', () => {
  it('calls a session in another repository STALE from the configured age on, and only below the CPU budget', () => {
    expect(classifyStatus(facts(), limits).status).toBe('STALE');
    expect(classifyStatus(facts({ elapsedSec: limits.staleSessionSec }), limits).status).toBe('STALE');
    expect(classifyStatus(facts({ elapsedSec: limits.staleSessionSec - 1 }), limits).status).toBe('IDLE');
    expect(classifyStatus(facts({ usedInWindowSec: STALE_CPU_BUDGET_SEC - 0.01 }), limits).status).toBe('STALE');
    const busy = classifyStatus(facts({ usedInWindowSec: STALE_CPU_BUDGET_SEC }), limits);
    expect(busy.status).toBe('IDLE');
    expect(busy.reason).toContain('in use: 8.00 s CPU time in the last 10m');
  });

  it('never calls a session stale that started a process within the window, or that it cannot measure', () => {
    const recent = classifyStatus(facts({ sinceNewChildMs: STALE_QUIET_SEC * 1000 - 1 }), limits);
    expect(recent.status).toBe('IDLE');
    expect(recent.reason).toContain('in use: started a process 9m ago');
    expect(classifyStatus(facts({ sinceNewChildMs: STALE_QUIET_SEC * 1000 }), limits).status).toBe('STALE');
    expect(classifyStatus(facts({ usedInWindowSec: undefined }), limits).reason).toContain('watching for 10m whether it is still in use');
    expect(classifyStatus(facts({ cpuTimeSec: undefined, usedInWindowSec: undefined }), limits).reason).toContain(
      'its CPU time cannot be read, so it is never called stale',
    );
  });

  it('never calls a process strayps holds STALE or FROZEN, and says it is held', () => {
    expect(classifyStatus(facts({ paused: true }), limits)).toEqual({
      status: 'IDLE',
      reason: 'Paused by strayps; resume continues it',
    });
    const orphan = facts({ category: 'child', ppid: 1, pgid: 300, cwd: undefined, displayCwd: undefined, elapsedSec: 60 });
    expect(classifyStatus(orphan, limits).status).toBe('FROZEN');
    expect(classifyStatus({ ...orphan, paused: true }, limits).status).toBe('IDLE');
  });

  it('calls an orphan FROZEN only when it left the process group it was started in, and never an agent', () => {
    const orphan = facts({ category: 'child', ppid: 1, pgid: 300, cwd: undefined, displayCwd: undefined, elapsedSec: 60 });
    expect(classifyStatus(orphan, limits).reason).toBe('Orphaned: its parent is gone (PPID 1), running for 7h 0m');
    // an app launchd started leads its own group
    expect(classifyStatus({ ...orphan, pgid: orphan.pid }, limits).status).not.toBe('FROZEN');
    expect(classifyStatus({ ...orphan, pgid: undefined }, limits).status).not.toBe('FROZEN');
    expect(classifyStatus({ ...orphan, category: 'agent' }, limits).status).not.toBe('FROZEN');
    expect(classifyStatus({ ...orphan, elapsedSec: limits.mcpSilenceTimeoutSec }, limits).status).toBe('FROZEN');
    expect(classifyStatus({ ...orphan, elapsedSec: limits.mcpSilenceTimeoutSec - 1 }, limits).status).not.toBe('FROZEN');
  });

  it('calls a process quiet from the silence timeout on, and quiet is not frozen', () => {
    const tool = facts({ category: 'child', cwd: '/work/repo', belongsToWatchedRepo: true, elapsedSec: 600 });
    expect(classifyStatus({ ...tool, silenceSec: limits.mcpSilenceTimeoutSec }, limits)).toEqual({
      status: 'IDLE',
      reason: 'Quiet: no CPU activity for 45s',
    });
    expect(classifyStatus({ ...tool, silenceSec: limits.mcpSilenceTimeoutSec - 1 }, limits).reason).toBe(
      'Active in current repository',
    );
    expect(classifyStatus({ ...tool, silenceSec: 600 }, { ...limits, agentActive: false }).reason).toBe(
      'Active in current repository',
    );
  });

  it('keeps an idle MCP server of an open editor out of STALE, with or without a repo cwd, but not one in a terminal', () => {
    const noCwd = facts({ category: 'mcp', cmd: 'node some-mcp-server', cwd: undefined, displayCwd: undefined });
    expect(classifyStatus({ ...noCwd, host: 'VS Code' }, limits).status).toBe('STANDBY');
    expect(classifyStatus({ ...noCwd, host: 'terminal' }, limits).status).toBe('STALE');
    const withCwd = facts({ category: 'mcp', cmd: 'node some-mcp-server', cwd: '/work/other', displayCwd: '/work/other' });
    expect(classifyStatus({ ...withCwd, host: 'VS Code' }, limits).status).toBe('STANDBY');
    expect(classifyStatus({ ...withCwd, host: 'terminal' }, limits).status).toBe('STALE');
  });

  it('keeps an idle MCP server or child of a non-stale agent out of STALE, while a sub-agent is judged on its own', () => {
    const server = facts({ category: 'mcp', cmd: 'node some-mcp-server', host: 'Claude Desktop' });
    expect(classifyStatus({ ...server, parentAgentStatus: 'ACTIVE' }, limits).status).toBe('STANDBY');
    expect(classifyStatus({ ...server, parentAgentStatus: 'IDLE' }, limits).status).toBe('STANDBY');
    expect(classifyStatus({ ...server, parentAgentStatus: 'STALE' }, limits).status).toBe('STALE');
    // Same when the MCP server has no working directory of its own
    const rootServer = { ...server, cwd: undefined, displayCwd: undefined };
    expect(classifyStatus({ ...rootServer, parentAgentStatus: 'ACTIVE' }, limits).status).toBe('STANDBY');
    expect(classifyStatus({ ...rootServer, parentAgentStatus: 'STALE' }, limits).status).toBe('STALE');

    const child = facts({ category: 'child', cmd: 'Chromium --headless' });
    expect(classifyStatus({ ...child, parentAgentStatus: 'ACTIVE' }, limits).status).toBe('IDLE');
    expect(classifyStatus({ ...child, parentAgentStatus: 'STALE' }, limits).status).toBe('STALE');

    // A sub-agent in another repository is a session of its own
    expect(classifyStatus(facts({ category: 'agent', parentAgentStatus: 'ACTIVE' }), limits).status).toBe('STALE');
  });

  it('shows a dev server of this repository as one, also when an agent runs it, and never as quiet', () => {
    const vite = facts({ cmd: 'node node_modules/.bin/vite', cwd: '/work/repo', belongsToWatchedRepo: true });
    expect(classifyStatus(vite, limits)).toEqual({
      status: 'ACTIVE',
      reason: 'Running dev server in current repository (7h 0m)',
    });
    const elsewhere = facts({ cmd: 'node node_modules/.bin/vite', category: 'child', elapsedSec: 100, formattedUptime: '1m 40s' });
    expect(classifyStatus(elsewhere, limits).reason).toBe('Session in /work/other (open for 1m 40s)');
  });

  it('never calls an agent of the watched repository stale, however old and quiet', () => {
    const agent = facts({ cwd: '/work/repo', belongsToWatchedRepo: true, elapsedSec: 30 * 3600, formattedUptime: '1d 6h' });
    expect(classifyStatus(agent, limits)).toEqual({
      status: 'IDLE',
      reason: 'Agent session in current repository (open for 1d 6h)',
    });
    expect(classifyStatus({ ...agent, detectedBy: 'mcp-client' }, limits).reason).toBe(
      'Agent session in current repository (open for 1d 6h) · recognized as an agent by the MCP server it started',
    );
  });
});
