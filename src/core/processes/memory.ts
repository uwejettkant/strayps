// Memory per process: the physical footprint where macOS can read it, RSS otherwise.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FOOTPRINT_BIN } from './system.js';
import type { MonitoredProcess } from './types.js';

const execFileAsync = promisify(execFile);

/** "125.0 MB", or "~125.0 MB" when the value is RSS and so only approximate. */
export function formatMemory(mb: number, approximate: boolean, digits = 1): string {
  return `${approximate ? '~' : ''}${mb.toFixed(digits)} MB`;
}

/** Memory of several processes together: approximate as soon as one value is. */
export function sumMemory(processes: Array<Pick<MonitoredProcess, 'memoryMb' | 'memorySource'>>, digits = 0): string {
  const mb = processes.reduce((sum, p) => sum + (p.memoryMb || 0), 0);
  return formatMemory(mb, processes.some((p) => p.memorySource !== 'footprint'), digits);
}

/** How often the physical footprint is read: `footprint` takes about a second for 30 processes. */
export const MEMORY_READ_INTERVAL_MS = 15_000;

/**
 * Footprint per requested PID from `footprint -f bytes -j` output: `auxiliary.phys_footprint`
 * (what Activity Monitor shows), or the process's `footprint` when that is missing. JSON, not the
 * text output: there each block starts with the process's own name, and a name can imitate the
 * header of another PID (review, 20.11.2026).
 */
export function parseFootprintJson(data: unknown, pids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (!data || typeof data !== 'object') return result;
  const { processes, 'bytes per unit': perUnit } = data as { processes?: unknown; 'bytes per unit'?: unknown };
  if (!Array.isArray(processes)) return result;
  const factor = typeof perUnit === 'number' && perUnit > 0 ? perUnit : 1;
  const requested = new Set(pids);
  for (const entry of processes) {
    if (!entry || typeof entry !== 'object') continue;
    const { pid, footprint, auxiliary } = entry as { pid?: unknown; footprint?: unknown; auxiliary?: unknown };
    if (typeof pid !== 'number' || !requested.has(pid)) continue;
    const phys = auxiliary && typeof auxiliary === 'object' ? (auxiliary as { phys_footprint?: unknown }).phys_footprint : undefined;
    const units = typeof phys === 'number' ? phys : typeof footprint === 'number' ? footprint : undefined;
    if (units !== undefined && Number.isFinite(units) && units >= 0) result.set(pid, units * factor);
  }
  return result;
}

/**
 * Reads the physical footprint with macOS `footprint`. It only reads, needs no root for one's own
 * processes, and does not stop them (measured on 20.11.2026: largest timer gap 2 ms in a process
 * it read five times; only `--forkCorpse`, not used, stopped it for 270 ms). Its JSON goes into a
 * private temporary directory, removed right after.
 */
export async function readFootprints(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'strayps-footprint-'));
  const jsonPath = path.join(dir, 'footprint.json');
  try {
    try {
      await execFileAsync(FOOTPRINT_BIN, ['-f', 'bytes', '-j', jsonPath, ...pids.flatMap((pid) => ['-p', String(pid)])], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      // A PID that is gone or belongs to another user makes it fail; the file still holds the others
    }
    let text: string;
    try {
      text = await fs.promises.readFile(jsonPath, 'utf8');
    } catch {
      return new Map();
    }
    try {
      return parseFootprintJson(JSON.parse(text), pids);
    } catch {
      return new Map();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
