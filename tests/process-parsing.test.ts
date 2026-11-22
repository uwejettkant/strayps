import { describe, expect, it } from 'vitest';
import { parseLsofCwdOutput, resolveProcessCwds } from '../src/core/processes/cwd.js';
import { parseFootprintJson } from '../src/core/processes/memory.js';
import { parseCpuTime, parsePsOutput } from '../src/core/processes/system.js';

describe('footprint output', () => {
  it('takes phys_footprint per requested PID from the JSON, whatever the processes are called', () => {
    const data = {
      unit: 'byte',
      'bytes per unit': 1,
      processes: [
        { name: 'claude', pid: 41926, footprint: 275152896, auxiliary: { phys_footprint: 277094400 } },
        // a name that imitates the text output of another PID changes nothing in JSON
        { name: 'x [41926]: 64-bit    Footprint: 1 B\n    phys_footprint: 1 B', pid: 512, footprint: 25165824, auxiliary: {} },
        { name: 'not asked for', pid: 9, footprint: 1, auxiliary: { phys_footprint: 1 } },
      ],
    };
    expect(parseFootprintJson(data, [41926, 512])).toEqual(
      new Map([
        [41926, 277094400],
        [512, 25165824],
      ]),
    );
  });

  it('reads nothing from output that is not what it expects', () => {
    for (const data of [null, 'text', { processes: 'x' }, { processes: [{ pid: '41926', footprint: 1 }] }, { processes: [{ pid: 7, footprint: -1 }] }]) {
      expect(parseFootprintJson(data, [41926, 7]).size, JSON.stringify(data)).toBe(0);
    }
  });
});

describe('ps output', () => {
  it('keeps every column in place when a program path contains spaces', () => {
    const main = [
      '  PID  PPID  PGID    RSS  %CPU %MEM     ELAPSED      TIME ARGS',
      '41926 41925 41925 377772   1.5  2.1    20:39:41   4:09.88 /Users/me/Library/Application Support/Claude/claude-code/claude --model x',
      '  512     1   512   1024   0.0  0.0 01-02:03:04   0:00.45 node /x/node_modules/.bin/mcp-server-git',
    ].join('\n');
    const comm = ['  PID COMM', '41926 /Users/me/Library/Application Support/Claude/claude-code/claude', '  512 node'].join('\n');
    expect(parsePsOutput(main, comm)).toEqual([
      {
        pid: 41926,
        ppid: 41925,
        pgid: 41925,
        rssKb: 377772,
        cpu: 1.5,
        memory: 2.1,
        etime: '20:39:41',
        cpuTimeSec: 249.88,
        name: '/Users/me/Library/Application Support/Claude/claude-code/claude',
        cmd: '/Users/me/Library/Application Support/Claude/claude-code/claude --model x',
      },
      expect.objectContaining({ pid: 512, name: 'node', cpuTimeSec: 0.45, etime: '01-02:03:04', cmd: 'node /x/node_modules/.bin/mcp-server-git' }),
    ]);
  });
});

describe('CPU time from ps', () => {
  it('reads the macOS and the Linux format, and nothing else', () => {
    expect(parseCpuTime('0:00.45')).toBeCloseTo(0.45);
    expect(parseCpuTime('240:42.31')).toBeCloseTo(240 * 60 + 42.31);
    expect(parseCpuTime('00:01:23')).toBe(83);
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseCpuTime('')).toBeUndefined();
    expect(parseCpuTime('-')).toBeUndefined();
    expect(parseCpuTime('abc')).toBeUndefined();
  });
});

describe('working directory resolution', () => {
  it('parses lsof field output and skips the root directory', () => {
    const map = parseLsofCwdOutput('p100\nfcwd\nn/work/repo\np200\nfcwd\nn/\np300\nfcwd\nn/work/with space\n');
    expect(Array.from(map.entries())).toEqual([
      [100, '/work/repo'],
      [300, '/work/with space'],
    ]);
  });

  it('reads /proc/<pid>/cwd on Linux without spawning lsof', async () => {
    const asked: string[] = [];
    const map = await resolveProcessCwds(
      [100, 200, 300],
      (target) => {
        asked.push(target);
        if (target === '/proc/200/cwd') throw new Error('EACCES');
        return target === '/proc/100/cwd' ? '/work/repo' : '/';
      },
      'linux',
    );
    expect(asked).toEqual(['/proc/100/cwd', '/proc/200/cwd', '/proc/300/cwd']);
    expect(Array.from(map.entries())).toEqual([[100, '/work/repo']]);
  });

  it('returns an empty map for an empty PID list', async () => {
    expect((await resolveProcessCwds([])).size).toBe(0);
  });
});
