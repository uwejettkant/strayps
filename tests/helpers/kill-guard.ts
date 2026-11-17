/**
 * Safety net for the whole test suite.
 *
 * agent-leash terminates processes for a living. A test that reaches the real `process.kill`
 * with the real process list would kill the developer's own agent sessions. While tests run,
 * `process.kill` therefore only works for liveness checks (signal 0) and for PIDs a test
 * explicitly spawned and registered here.
 */
const allowed = new Set<number>();
const blocked: Array<{ pid: number; signal: string | number | undefined }> = [];
let installed = false;

export function allowKill(pid: number): void {
  allowed.add(pid);
}

/** Kill attempts that were refused since the last call (for assertions). */
export function takeBlockedKills(): Array<{ pid: number; signal: string | number | undefined }> {
  return blocked.splice(0, blocked.length);
}

export function installKillGuard(): void {
  if (installed) return;
  installed = true;
  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 0 || allowed.has(pid)) {
      return realKill(pid, signal);
    }
    blocked.push({ pid, signal });
    throw new Error(
      `process.kill(${pid}, ${String(signal)}) blocked by tests/helpers/kill-guard.ts — inject a processKiller or call allowKill(pid) for a process the test spawned`,
    );
  }) as typeof process.kill;
}
