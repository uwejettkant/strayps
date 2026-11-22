// One reading of the process table as a tree. Every walk of the monitor up or down the tree goes
// through here, so the places that must agree on what lies above or below a process (what an agent
// started, what pause holds, what runs under strayps itself) read the same chain. Where a walk
// stops differs on purpose and stays visible where it is called. The session's kill plan walks the
// last scan's parents through `ProcessMonitor.parentOf`, with its own stop rules.

import type { RawProcessInfo } from './types.js';

/**
 * How many steps a walk takes at most: a guard against a cycle in a table that changed while `ps`
 * read it, not a rule about which processes count.
 */
export const MAX_TREE_DEPTH = 32;

export class ProcessTree {
  readonly raws: readonly RawProcessInfo[];
  private readonly byPid = new Map<number, RawProcessInfo>();
  private readonly childrenOf = new Map<number, RawProcessInfo[]>();

  constructor(raws: readonly RawProcessInfo[]) {
    this.raws = raws;
    for (const raw of raws) {
      this.byPid.set(raw.pid, raw);
      if (!raw.ppid) continue;
      const siblings = this.childrenOf.get(raw.ppid);
      if (siblings) siblings.push(raw);
      else this.childrenOf.set(raw.ppid, [raw]);
    }
  }

  get(pid: number): RawProcessInfo | undefined {
    return this.byPid.get(pid);
  }

  has(pid: number): boolean {
    return this.byPid.has(pid);
  }

  /** True when a process of this table names `pid` as its parent. */
  hasChildren(pid: number): boolean {
    return this.childrenOf.has(pid);
  }

  /** The parent as this table has it; undefined for a PID it does not list. */
  parentOf(pid: number): number | undefined {
    return this.byPid.get(pid)?.ppid;
  }

  /**
   * The ancestors of `pid`, nearest first, up to PID 1 (never included) or the first PID whose
   * parent is unknown. With `orElse`, a parent this table does not know is taken from that one:
   * a new look at the table and the last scan describe the same processes.
   */
  ancestors(pid: number, orElse?: ProcessTree): number[] {
    const parent = (of: number): number | undefined => this.parentOf(of) ?? orElse?.parentOf(of);
    const chain: number[] = [];
    for (let cur = parent(pid); cur && cur > 1 && chain.length < MAX_TREE_DEPTH; cur = parent(cur)) {
      chain.push(cur);
    }
    return chain;
  }

  /** `pid` itself, then its ancestors: as many steps as `ancestors` takes, counting `pid`. */
  selfAndAncestors(pid: number): number[] {
    if (!(pid > 1)) return [];
    return [pid, ...this.ancestors(pid)].slice(0, MAX_TREE_DEPTH);
  }

  /**
   * Everything below `roots`, breadth first: a parent always comes before what it runs, so a walk
   * over the result can stop at a process and skip what lies below it.
   */
  below(roots: Iterable<number>): RawProcessInfo[] {
    const result: RawProcessInfo[] = [];
    const visited = new Set<number>(roots);
    let level = Array.from(visited);
    for (let depth = 0; level.length > 0 && depth < MAX_TREE_DEPTH; depth++) {
      const next: number[] = [];
      for (const pid of level) {
        for (const child of this.childrenOf.get(pid) ?? []) {
          if (visited.has(child.pid)) continue;
          visited.add(child.pid);
          result.push(child);
          next.push(child.pid);
        }
      }
      level = next;
    }
    return result;
  }
}
