// The fake process table the ProcessMonitor tests share: a monitor that never reaches a real
// process, and records of agents and MCP servers to fill it with.
import { ProcessMonitor } from '../../src/core/process-monitor.js';
import type { RawProcessInfo } from '../../src/core/processes/types.js';

export const REPO = '/work/current-repo';
export const OTHER = '/work/other-repo';

export interface Setup {
  monitor: ProcessMonitor;
  kills: Array<{ pid: number; signal: NodeJS.Signals | undefined }>;
  procs: RawProcessInfo[];
  alive: Set<number>;
}

export function setup(
  procs: RawProcessInfo[],
  options: {
    killGraceMs?: number;
    selfPid?: number;
    processAge?: (pid: number) => number | undefined;
    processAges?: (pids: number[]) => Map<number, number>;
    processTree?: () => RawProcessInfo[] | undefined;
    rootDir?: string;
  } = {},
): Setup {
  const kills: Setup['kills'] = [];
  const alive = new Set(procs.map((p) => p.pid));
  const table = [...procs];
  const monitor = new ProcessMonitor({
    rootDir: options.rootDir ?? REPO,
    selfPid: options.selfPid ?? 999_999,
    killGraceMs: options.killGraceMs ?? 3000,
    processLister: async () => table.filter((p) => alive.has(p.pid)),
    processKiller: (pid, signal) => {
      kills.push({ pid, signal });
      return alive.has(pid);
    },
    processAlive: (pid) => alive.has(pid),
    processAge: options.processAge,
    processAges: options.processAges,
    // what pause sees when it looks again right after holding the agents: the table as it is now
    processTree: 'processTree' in options ? options.processTree : () => table.filter((p) => alive.has(p.pid)),
  });
  return { monitor, kills, procs: table, alive };
}

export const agent = (pid: number, cwd: string, extra: Partial<RawProcessInfo> = {}): RawProcessInfo => ({
  pid,
  name: 'claude',
  cmd: 'claude --model claude-sonnet-5-5',
  cwd,
  cpu: 0,
  rssKb: 150_000,
  etime: '10:00',
  ...extra,
});

/** As macOS ps reports an editor's process: its name is the full path of the executable. */
export const VSCODE_HELPER =
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';

export const mcp = (pid: number, ppid: number, extra: Partial<RawProcessInfo> = {}): RawProcessInfo => ({
  pid,
  ppid,
  name: 'node',
  cmd: 'node /x/node_modules/.bin/some-mcp-server',
  cpu: 0,
  rssKb: 30_000,
  etime: '10:00',
  ...extra,
});
