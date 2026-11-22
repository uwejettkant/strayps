import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ProcessMonitor } from '../src/core/process-monitor.js';
import { redactSecrets } from '../src/core/processes/command-line.js';
import { MEMORY_READ_INTERVAL_MS } from '../src/core/processes/memory.js';
import { defaultProcessAges } from '../src/core/processes/system.js';
import { createHarness } from './helpers/harness.js';
import { agent, mcp, OTHER, REPO, setup } from './helpers/processes.js';

describe('ProcessMonitor bookkeeping', () => {
  it('forgets the history of a process it ended, so a new process under its PID starts clean', async () => {
    const h = createHarness({ procs: [{ pid: 300, name: 'claude', cmd: 'claude', cwd: OTHER, rssKb: 120_000, etime: '03-00:00:00', cpuTimeSec: 10 }], killGraceMs: 0 });
    await h.monitor.scan();
    // internal state, read through a cast
    const state = h.monitor as unknown as { cpuSamples: Map<number, unknown>; children: Map<number, unknown>; footprints: Map<number, unknown> };
    expect([state.cpuSamples.has(300), state.children.has(300), state.footprints.has(300)]).toEqual([true, true, true]);
    expect(h.monitor.killProcess(300)).toBe(true);
    await h.monitor.scan();
    expect([state.cpuSamples.has(300), state.children.has(300), state.footprints.has(300)]).toEqual([false, false, false]);
  });

  it('reads the age of several processes with one ps call, and keeps those it found', () => {
    // read-only: ps on this process and on a PID that is almost surely free
    const ages = defaultProcessAges([process.pid, 99_998]);
    expect(ages.get(process.pid)).toBeGreaterThanOrEqual(0);
    expect([...ages.keys()].every((pid) => pid === process.pid || pid === 99_998)).toBe(true);
    expect(defaultProcessAges([])).toEqual(new Map());
  });
});

describe('secrets in command lines', () => {
  it('shows command lines with token, key and password values and URL credentials redacted', async () => {
    const { monitor } = setup([
      mcp(70, 69, { cmd: 'node /x/node_modules/.bin/mcp-server-api --api-key sk-live-123 --token=abc API_SECRET=s3cr3t https://me:pw@example.com/x' }),
    ]);
    const [proc] = await monitor.scan(Date.now());
    expect(proc.category).toBe('mcp');
    expect(proc.cmd).not.toMatch(/sk-live-123|abc|s3cr3t|me:pw/);
    expect(redactSecrets('tool --api-key sk-1 --password hunter2 --verbose')).toBe('tool --api-key [redacted] --password [redacted] --verbose');
    expect(redactSecrets('git clone https://user:pw@github.com/a/b')).toBe('git clone https://[redacted]@github.com/a/b');
    // flags that only look alike keep their value when it is another flag
    expect(redactSecrets('node server --auth-mode -v')).toBe('node server --auth-mode -v');
    // only where a flag starts: a path that contains "auth" keeps the word after it
    expect(redactSecrets('/srv/mcp-auth-proxy.js /Users/x/repoA')).toBe('/srv/mcp-auth-proxy.js /Users/x/repoA');
    expect(redactSecrets('node --no-auth server.js')).toBe('node --no-auth server.js');
    expect(redactSecrets('tool --key abc --openai-key def')).toBe('tool --key [redacted] --openai-key [redacted]');
    expect(redactSecrets('curl -H x-api-key: v123 -H Authorization: token ghp_abcdefghijklmnop')).toBe(
      'curl -H x-api-key: [redacted] -H Authorization: token [redacted]',
    );
  });

  it('redacts query parameters, JSON keys, quoted values, tokens before the @ of a URL and common token formats', () => {
    // each of these was shown in full (external audit, 21.11.2026)
    const cases: Array<[string, string]> = [
      ['mcp-remote https://api.example.com/sse?api_key=SUPERSECRET1&foo=bar', 'mcp-remote https://api.example.com/sse?api_key=[redacted]&foo=bar'],
      ['mcp-remote https://api.example.com/sse?x=1&token=SUPERSECRET1', 'mcp-remote https://api.example.com/sse?x=1&token=[redacted]'],
      [`x --headers '{"x-api-key":"SUPERSECRET1"}'`, `x --headers '{"x-api-key":"[redacted]"}'`],
      ['x --headers {"Authorization": "Bearer A B", "accept": "json"}', 'x --headers {"Authorization": "[redacted]", "accept": "json"}'],
      // quotes that are part of the argument (a command for sh -c): up to the closing one
      ['sh -c x --token "my secret with spaces" --other', 'sh -c x --token [redacted] --other'],
      ["sh -c x --token='my secret' --next", 'sh -c x --token=[redacted] --next'],
      ['sh -c x API_KEY="a b c" y', 'sh -c x API_KEY=[redacted] y'],
      ['git clone https://SUPERSECRETTOKEN1@github.com/a/b', 'git clone https://[redacted]@github.com/a/b'],
      ['curl --header=Authorization: token abc123', 'curl --header=Authorization: token [redacted]'],
      [
        'x AIzaSyA1234567890abcdefghijklmnopqrstu AKIAIOSFODNN7EXAMPLE npm_abcdefghijklmnopqrstuvwxyz0123456789 glpat-abcdefghij1234567890',
        'x [redacted] [redacted] [redacted] [redacted]',
      ],
    ];
    for (const [cmd, shown] of cases) expect(redactSecrets(cmd), cmd).toBe(shown);

    // shapes the first rewrite showed in full and the old patterns had hidden (safety review, 21.11.2026)
    const kept: Array<[string, string]> = [
      ['curl -H Accept:json,Authorization:Basic dXNlcjpwYXNz https://x', 'curl -H Accept:json,Authorization:Basic [redacted] https://x'],
      ['x {Authorization: token abc123def}', 'x {Authorization: token [redacted]}'],
      ['x headers:Authorization:token abc123def', 'x headers:Authorization:token [redacted]'],
      ['x -H x-api-key : v123', 'x -H x-api-key : [redacted]'],
      ['sh -c curl -H x-api-key:"abc123" https://x', 'sh -c curl -H x-api-key:"[redacted]" https://x'],
      ['sh -c curl -H "x-api-key: abc 123" https://x', 'sh -c curl -H "x-api-key: [redacted]" https://x'],
      ["sh -c curl -H 'Authorization: Bearer abc def'", "sh -c curl -H 'Authorization: Bearer [redacted]'"],
      ['redis-cli -u redis://default:pa#ss@host:6379', 'redis-cli -u redis://[redacted]@host:6379'],
      ['psql postgres://u:p?w@h/db', 'psql postgres://[redacted]@h/db'],
      ['pip install -ihttps://user:tok@host/simple x', 'pip install -ihttps://[redacted]@host/simple x'],
      [`x ${'a'.repeat(40)}+db://u:pw@h`, `x ${'a'.repeat(40)}+db://[redacted]@h`],
      ['node --NO-auth secret-value', 'node --NO-auth secret-value'],
    ];
    for (const [cmd, shown] of kept) expect(redactSecrets(cmd), cmd).toBe(shown);

    // what only looks alike stays readable
    for (const cmd of [
      'npx -y @modelcontextprotocol/server-github@1.2.3 https://registry.npmjs.org/@scope/pkg',
      'docker run -p 8080:80 -v /data:/run/data image:latest localhost:3000',
      'node --inspect=127.0.0.1:9229 x.js PATH=/usr/bin:/bin',
      'claude --model claude-sonnet-5-5 --permission-mode acceptEdits',
      'x --token',
      'x --token= y',
    ]) {
      expect(redactSecrets(cmd), cmd).toBe(cmd);
    }
  });

  it('takes milliseconds for a command line of 100,000 characters, not seconds per scan', async () => {
    // One argument of 50,000 letters held every scan for 2.7 s: the patterns started anew at each
    // character (external audit, 21.11.2026). macOS allows command lines of 1 MB.
    const n = 100_000;
    const hostile = [
      ' ' + 'a'.repeat(n),
      ' ' + 'token'.repeat(n / 5),
      ' ' + 'x-'.repeat(n / 2),
      ' --' + 'a-'.repeat(n / 2),
      ' ' + 'a://b:'.repeat(n / 6),
      ' "token":"' + 'x'.repeat(n),
      ' ?' + 'token=a&'.repeat(n / 8),
      ' --token "a'.repeat(n / 11),
      ' ' + 'sk-'.repeat(n / 3),
      ' "token:a'.repeat(n / 9),
      ' token:"a'.repeat(n / 9),
      ' ' + 'token:a,'.repeat(n / 8),
      ' x://' + 'a:'.repeat(n / 2),
    ];
    for (const cmd of hostile) {
      const started = performance.now();
      redactSecrets(cmd);
      expect(performance.now() - started, cmd.slice(0, 12)).toBeLessThan(250);
    }

    // the whole scan, with such a line on an agent, an MCP server and a process nobody lists
    const { monitor } = setup([
      agent(100, REPO, { cmd: `claude -p ${'a'.repeat(n)}` }),
      mcp(101, 100, { cmd: `node /x/node_modules/.bin/some-mcp-server ${'token'.repeat(n / 5)}` }),
      { pid: 300, ppid: 1, name: 'python3', cmd: `python3 -c ${'x-'.repeat(n / 2)}`, etime: '10:00' },
    ]);
    const started = performance.now();
    const list = await monitor.scan(1_000);
    expect(performance.now() - started).toBeLessThan(500);
    expect(list.map((p) => p.pid).sort()).toEqual([100, 101]);
  });

  it('redacts before it shortens: a secret cut at the edge of the line stays hidden', async () => {
    // Shortened first, a URL lost its "@" and a token its length, and neither was recognized any
    // more: the visible part of the password or token was shown (external audit, 21.11.2026)
    const { monitor } = setup([
      mcp(70, 69, { cmd: `node mcp-proxy ${'a'.repeat(60)} https://u:hunter2hunter2hunter2@host.example/x` }),
      agent(80, REPO, { cmd: `claude ${'x'.repeat(60)} ghp_abcdefghijklmnopqrstuvwxyz` }),
    ]);
    const list = await monitor.scan(Date.now());
    const text = list.map((p) => p.cmd).join('\n');
    expect(list).toHaveLength(2);
    expect(text).not.toMatch(/hunter|ghp_a/);
  });
});

describe('working directories', () => {
  it('shortens the home directory to ~, but not a directory whose name only starts like it', async () => {
    // /Users/x-backup/repo was shown as ~-backup/repo (external audit, 21.11.2026)
    const home = os.homedir();
    const { monitor } = setup([agent(100, `${home}/projects/app`), agent(200, `${home}-backup/repo`), agent(300, home)]);
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p.cwd]));
    expect(byPid.get(100)).toBe('~/projects/app');
    expect(byPid.get(200)).toBe(`${home}-backup/repo`);
    expect(byPid.get(300)).toBe('~');
  });
});

describe('memory', () => {
  // RSS was wrong both ways: an idle MCP server showed 12 KB RSS and 24 MB footprint, a Claude
  // session 486 MB RSS and 263 MB footprint (measured on 20.11.2026)
  function withReader(reader: (pids: number[]) => Promise<Map<number, number>>) {
    const procs = [agent(100, REPO, { cpu: 1, rssKb: 486_000 }), mcp(101, 100, { rssKb: 12 })];
    const calls: number[][] = [];
    const monitor = new ProcessMonitor({
      rootDir: REPO,
      selfPid: 999_999,
      processLister: async () => procs,
      memoryReader: async (pids) => {
        calls.push([...pids].sort((a, b) => a - b));
        return reader(pids);
      },
    });
    return { monitor, calls, procs };
  }
  const MB = 1024 * 1024;

  it('shows the physical footprint, and RSS marked as approximate where it cannot be read', async () => {
    const { monitor } = withReader(async () => new Map([[100, 263 * MB]]));
    const byPid = new Map((await monitor.scan(1_000)).map((p) => [p.pid, p]));
    expect(byPid.get(100)).toMatchObject({ memoryMb: 263, memorySource: 'footprint' });
    // 12 KB RSS: shown, but not as the footprint
    expect(byPid.get(101)).toMatchObject({ memoryMb: 0, memorySource: 'rss' });
  });

  it('reads the footprint at most every 15 seconds, and forgets the value of a PID that left the list', async () => {
    const { monitor, calls, procs } = withReader(async (pids) => new Map(pids.map((pid) => [pid, 50 * MB])));
    const t0 = 1_000_000;
    await monitor.scan(t0);
    await monitor.scan(t0 + 2_000);
    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 1);
    expect(calls).toEqual([[100, 101]]);

    // 101 exits and a new MCP server gets the same PID before the next read
    const gone = procs.splice(1, 1)[0];
    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 500);
    procs.push({ ...gone, cmd: 'node /x/node_modules/.bin/mcp-server-time', rssKb: 20_480, etime: '00:01' });
    const reused = (await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS - 200)).find((p) => p.pid === 101)!;
    expect(reused).toMatchObject({ memoryMb: 20, memorySource: 'rss' });

    await monitor.scan(t0 + MEMORY_READ_INTERVAL_MS);
    expect(calls).toHaveLength(2);
  });

  it('falls back to RSS for good when the system has no footprint tool, and for one read on any other failure', async () => {
    let failure: NodeJS.ErrnoException | null = Object.assign(new Error('spawn footprint ENOENT'), { code: 'ENOENT' });
    const { monitor, calls } = withReader(async () => {
      if (failure) throw failure;
      return new Map([[100, 263 * MB]]);
    });
    const [first] = await monitor.scan(1_000);
    expect(first.memorySource).toBe('rss');
    failure = null;
    await monitor.scan(1_000 + MEMORY_READ_INTERVAL_MS);
    expect(calls).toHaveLength(1);

    const flaky = withReader(async () => {
      if (failure) throw failure;
      return new Map([[100, 263 * MB]]);
    });
    failure = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect((await flaky.monitor.scan(1_000))[0].memorySource).toBe('rss');
    failure = null;
    expect((await flaky.monitor.scan(1_000 + MEMORY_READ_INTERVAL_MS))[0]).toMatchObject({ memorySource: 'footprint', memoryMb: 263 });
  });

  it('never inspects the memory of a PID from a custom process table', async () => {
    // tests and the demo make PIDs up; on a real machine they can name anyone's process
    const monitor = new ProcessMonitor({ rootDir: REPO, selfPid: 999_999, processLister: async () => [agent(100, REPO, { rssKb: 2048 })] });
    const [proc] = await monitor.scan(1_000);
    expect(proc).toMatchObject({ memoryMb: 2, memorySource: 'rss' });
  });
});
