import { describe, expect, it } from 'vitest';
import { MAX_TREE_DEPTH, ProcessTree } from '../src/core/processes/tree.js';
import type { RawProcessInfo } from '../src/core/processes/types.js';

const proc = (pid: number, ppid?: number): RawProcessInfo => ({ pid, ppid, name: `p${pid}` });

describe('ProcessTree', () => {
  // launchd (1) → terminal (10) → shell (20) → agent (30) → tool call (40)
  const tree = new ProcessTree([proc(1, 0), proc(10, 1), proc(20, 10), proc(30, 20), proc(40, 30)]);

  it('walks up nearest first and stops before PID 1', () => {
    expect(tree.ancestors(40)).toEqual([30, 20, 10]);
    expect(tree.ancestors(10)).toEqual([]);
    expect(tree.parentOf(40)).toBe(30);
  });

  it('stops after a parent the table does not list, and knows nothing of an unlisted PID', () => {
    const partial = new ProcessTree([proc(40, 30), proc(30, 25)]);
    expect(partial.ancestors(40)).toEqual([30, 25]);
    expect(partial.ancestors(99)).toEqual([]);
    expect(partial.parentOf(99)).toBeUndefined();
  });

  it('stops at a parent of 0, as ps reports it for the kernel', () => {
    expect(new ProcessTree([proc(5, 0), proc(6, 5)]).ancestors(6)).toEqual([5]);
  });

  it('takes a parent it does not know from another reading, never one it knows', () => {
    const fresh = new ProcessTree([proc(500, 400)]);
    const lastScan = new ProcessTree([proc(500, 401), proc(400, 300), proc(300, 1)]);
    expect(fresh.ancestors(500)).toEqual([400]);
    expect(fresh.ancestors(500, lastScan)).toEqual([400, 300]);
    expect(fresh.ancestors(600, lastScan)).toEqual([]);
  });

  it('ends a walk in a cycle after MAX_TREE_DEPTH steps', () => {
    const cycle = new ProcessTree([proc(2, 3), proc(3, 2)]);
    expect(cycle.ancestors(2)).toHaveLength(MAX_TREE_DEPTH);
    expect(cycle.selfAndAncestors(2)).toHaveLength(MAX_TREE_DEPTH);
    expect(cycle.below([2])).toEqual([proc(3, 2)]);
  });

  it('names the process itself first, then its ancestors, in as many steps as a walk up takes', () => {
    expect(tree.selfAndAncestors(40)).toEqual([40, 30, 20, 10]);
    expect(tree.selfAndAncestors(1)).toEqual([]);
    const chain = new ProcessTree(Array.from({ length: 40 }, (_, i) => proc(100 + i, i === 0 ? 1 : 99 + i)));
    expect(chain.ancestors(139)).toHaveLength(MAX_TREE_DEPTH);
    expect(chain.selfAndAncestors(139)).toEqual([139, ...chain.ancestors(139).slice(0, MAX_TREE_DEPTH - 1)]);
    // down as many levels as a walk up takes steps
    expect(chain.below([100]).map((raw) => raw.pid)).toEqual(Array.from({ length: MAX_TREE_DEPTH }, (_, i) => 101 + i));
  });

  it('lists what runs below some processes breadth first: a parent before what it runs', () => {
    const work = new ProcessTree([
      proc(30, 20),
      proc(31, 20),
      proc(40, 30),
      proc(41, 31),
      proc(50, 40),
      proc(60, 99),
    ]);
    expect(work.below([30, 31]).map((raw) => raw.pid)).toEqual([40, 41, 50]);
    expect(work.below([20]).map((raw) => raw.pid)).toEqual([30, 31, 40, 41, 50]);
    // a root below another root is not listed again, nor is what runs below it listed twice
    expect(work.below([20, 30]).map((raw) => raw.pid)).toEqual([31, 40, 41, 50]);
    expect(work.below([])).toEqual([]);
  });

  it('knows which processes started another one', () => {
    expect(tree.hasChildren(30)).toBe(true);
    expect(tree.hasChildren(40)).toBe(false);
    // no process is the child of PID 0
    expect(tree.hasChildren(0)).toBe(false);
    expect(tree.has(40)).toBe(true);
    expect(tree.has(41)).toBe(false);
    expect(tree.get(40)).toEqual(proc(40, 30));
  });
});
