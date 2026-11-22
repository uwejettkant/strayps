// Working directories of processes: where an agent works decides which repository it belongs to.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { LSOF_BIN } from './system.js';

const execFileAsync = promisify(execFile);

/**
 * Parses `lsof -a -d cwd -p <pids> -Fn` output (`p<pid>` / `n<path>` records).
 */
export function parseLsofCwdOutput(stdout: string): Map<number, string> {
  const cwdMap = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('n') && currentPid !== null) {
      const rawPath = line.slice(1).trim();
      if (rawPath && rawPath !== '/') {
        cwdMap.set(currentPid, rawPath);
      }
    }
  }
  return cwdMap;
}

/**
 * Resolves the working directory (`cwd`) for a list of PIDs: `/proc/<pid>/cwd` on Linux,
 * `lsof` elsewhere. Unresolvable PIDs are simply missing from the result.
 */
export async function resolveProcessCwds(
  pids: number[],
  readLink: (target: string) => string = fs.readlinkSync,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, string>> {
  const cwdMap = new Map<number, string>();
  if (pids.length === 0) return cwdMap;

  if (platform === 'linux') {
    for (const pid of pids) {
      try {
        const cwd = readLink(`/proc/${pid}/cwd`);
        if (cwd && cwd !== '/') cwdMap.set(pid, cwd);
      } catch {
        // Process gone or owned by another user
      }
    }
    if (cwdMap.size > 0) return cwdMap;
  }

  try {
    const { stdout } = await execFileAsync(
      LSOF_BIN,
      ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'],
      { timeout: 1500 },
    );
    return parseLsofCwdOutput(stdout);
  } catch (err) {
    // lsof exits non-zero when some PIDs vanished but still prints the rest
    const partial = (err as { stdout?: unknown }).stdout;
    if (typeof partial === 'string' && partial.length > 0) {
      return parseLsofCwdOutput(partial);
    }
    // lsof missing, permission boundary, or timeout
  }
  return cwdMap;
}

/**
 * The home directory as strayps compares it: HOME=/Users/x/ names the same directory as /Users/x.
 * With the slash, an agent started in the home directory was not seen as working there, and its
 * kill plan took along the other agents started there (safety review, 21.11.2026).
 */
export function homeDirectory(): string {
  return os.homedir().replace(/\/+$/, '');
}
