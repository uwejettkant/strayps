import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const htmlPath = path.resolve(__dirname, '../src/ui/public/index.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

interface FakeElement {
  id: string;
  textContent: string;
  innerHTML: string;
  className: string;
  open: boolean;
  returnValue: string;
  content: string;
  listeners: Record<string, Array<(event: unknown) => unknown>>;
  attributes: Record<string, string>;
}

/**
 * Runs the dashboard's own script against a minimal stand-in for the DOM.
 * Enough to call `renderStatus` and read the markup it produces; no browser needed.
 */
function loadDashboard() {
  const script = html.match(/<script nonce="__LEASH_NONCE__">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('inline dashboard script not found');

  const elements = new Map<string, FakeElement>();
  const requests: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const documentListeners: Record<string, Array<(event: unknown) => unknown>> = {};

  const makeElement = (id: string): FakeElement & Record<string, unknown> => ({
    id,
    textContent: '',
    innerHTML: '',
    className: '',
    open: false,
    returnValue: '',
    content: id === 'meta-token' ? 'token-from-meta' : '',
    listeners: {},
    attributes: {},
    addEventListener(name: string, fn: (event: unknown) => unknown) {
      (this.listeners[name] ??= []).push(fn);
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    classList: { toggle() {}, add() {}, remove() {} },
  });

  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id)!;
  };

  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {}
  }

  const context = vm.createContext({
    console,
    setTimeout,
    Element: class {},
    HTMLDialogElement: { prototype: { closedBy: 'any' } },
    HTMLButtonElement: { prototype: {} },
    EventSource: FakeEventSource,
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, status: null, pausedPids: [], resumedPids: [] }) };
    },
    document: {
      getElementById,
      querySelector: (selector: string) =>
        selector === 'meta[name="leash-token"]' ? getElementById('meta-token') : null,
      querySelectorAll: () => [],
      addEventListener(name: string, fn: (event: unknown) => unknown) {
        (documentListeners[name] ??= []).push(fn);
      },
    },
  });

  vm.runInContext(script, context);
  const api = context as unknown as {
    renderStatus: (state: unknown) => void;
    esc: (value: unknown) => string;
    killProcess: (pid: number) => Promise<void>;
  };
  return { api, elements, getElementById, requests, documentListeners };
}

const HOSTILE = `<img src=x onerror="fetch('/api/panic',{method:'POST'})">`;

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: '/work/repo',
    config: {
      protectedFiles: ['.env*'],
      limits: { maxFilesWarn: 15, maxFilesHardStop: 40, maxEditsPerFilePerMinute: 5, mcpSilenceTimeoutSec: 45 },
    },
    checkpoint: { ref: 'abc1234', type: 'git-head', snapshottedFiles: 3, createdAt: 0 },
    modifiedFiles: [],
    trippedFiles: [],
    limitState: 'ok',
    events: [],
    processes: [],
    timestamp: 0,
    ...overrides,
  };
}

describe('dashboard page', () => {
  it('contains no inline event handlers and no script without the nonce', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script src="https://cdn.tailwindcss.com">', '<script nonce="__LEASH_NONCE__">']);
    expect(html).toContain('<meta name="leash-token" content="__LEASH_TOKEN__" />');
    expect(html).not.toContain('v0.1.0');
  });

  it('escapes every character that could start markup', () => {
    const { api } = loadDashboard();
    expect(api.esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(api.esc(undefined)).toBe('');
    expect(api.esc(0)).toBe('0');
  });

  it('renders hostile file names as text, in the event list and on the revert button', () => {
    const { api, getElementById } = loadDashboard();
    const filePath = `src/${HOSTILE}.ts`;
    api.renderStatus(
      stateWith({
        modifiedFiles: [filePath],
        events: [
          { id: '1', type: 'file-edit', severity: 'info', timestamp: 0, filePath, message: `ADD: ${filePath} (1/5 edits/min)` },
          { id: '2', type: `x"><script>alert(1)</script>`, severity: `"><b>`, timestamp: 0, message: `'"><svg onload=alert(1)>` },
        ],
      }),
    );

    const markup = getElementById('activity-list').innerHTML;
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<svg');
    expect(markup).not.toContain('<b>');
    expect(markup).toContain('&lt;img src=x onerror=&quot;fetch(&#39;/api/panic&#39;');
    // the path travels in an attribute, intact after unescaping, never inside generated JavaScript
    expect(markup).toContain(`data-action="revert" data-path="src/&lt;img src=x onerror=&quot;`);
    expect(markup).not.toContain('onclick');
    // every attribute value is still enclosed by its quotes
    for (const value of markup.match(/="[^"]*"/g) ?? []) {
      expect(value).not.toMatch(/[<>]/);
    }
  });

  it('renders hostile process command lines, directories and reasons as text', () => {
    const { api, getElementById } = loadDashboard();
    api.renderStatus(
      stateWith({
        processes: [
          {
            pid: 4711,
            status: `STALE"><img src=x onerror=alert(1)>`,
            category: `<i>mcp</i>`,
            cmd: `node ${HOSTILE}`,
            cwd: `/tmp/${HOSTILE}`,
            reason: HOSTILE,
            host: `<u>VS Code</u>`,
            uptime: `<s>1d</s>`,
            memoryMb: 12.5,
            cpu: 0,
            inWatchedRepo: false,
          },
          { pid: `1); alert(1); (`, status: 'ACTIVE', category: 'agent', cmd: 'claude', memoryMb: 1, cpu: 0, inWatchedRepo: true },
        ],
      }),
    );

    const markup = getElementById('process-list').innerHTML;
    for (const tag of ['<img', '<i>', '<u>', '<s>', '<script']) {
      expect(markup, tag).not.toContain(tag);
    }
    expect(markup).toContain('data-action="kill"');
    expect(markup).toContain('data-pid="4711"');
    // a PID that is not a number can never become one in the markup
    expect(markup).toContain('data-pid="0"');
    expect(markup).not.toContain('alert(1); (');
    for (const value of markup.match(/="[^"]*"/g) ?? []) {
      expect(value).not.toMatch(/[<>]/);
    }
  });

  it('labels a process by where it really runs, and never as safe to kill', () => {
    const { api, getElementById } = loadDashboard();
    const proc = { status: 'ACTIVE', category: 'agent', cmd: 'claude', memoryMb: 1, cpu: 1 };
    api.renderStatus(
      stateWith({
        processes: [
          { ...proc, pid: 1, inWatchedRepo: true, pauseTarget: true },
          { ...proc, pid: 2, inWatchedRepo: false, status: 'STALE' },
          { ...proc, pid: 3, inWatchedRepo: false, host: 'detached', status: 'FROZEN', category: 'mcp' },
        ],
      }),
    );
    const markup = getElementById('process-list').innerHTML;
    expect(markup.match(/THIS REPO/g)).toHaveLength(1);
    expect(markup.match(/ELSEWHERE/g)).toHaveLength(1);
    expect(markup.match(/DETACHED/g)).toHaveLength(1);
    expect(markup.match(/AGENT TREE/g)).toHaveLength(1);
    expect(markup).not.toMatch(/safe to kill|kill stale/i);
    expect(getElementById('metric-silence-limit').textContent).not.toMatch(/safe to kill|reclaimable/i);
  });

  it('asks before a revert and before a kill, whatever the file or process looks like', async () => {
    const { api, getElementById, requests, documentListeners } = loadDashboard();
    api.renderStatus(
      stateWith({
        modifiedFiles: ['src/a.ts'],
        processes: [{ pid: 4711, status: 'FROZEN', category: 'agent', cmd: 'node x-agent', reason: 'No CPU or file activity for 50s', memoryMb: 1, cpu: 0, inWatchedRepo: false }],
      }),
    );
    const ElementClass = (api as unknown as { Element: new () => object }).Element;
    const click = (attributes: Record<string, string>) => {
      const button = { getAttribute: (name: string) => attributes[name] ?? null };
      const target = Object.assign(new ElementClass(), { closest: () => button });
      for (const listener of documentListeners.click ?? []) listener({ target });
    };
    const dialog = getElementById('confirm-dialog');
    const answer = async (choice: string) => {
      dialog.returnValue = choice;
      dialog.open = false;
      for (const listener of dialog.listeners.close ?? []) await listener({});
    };

    click({ 'data-action': 'revert', 'data-path': 'src/a.ts' });
    expect(dialog.open).toBe(true);
    expect(getElementById('confirm-dialog-heading').textContent).toBe('Roll back src/a.ts?');
    await answer('cancel');
    click({ 'data-action': 'kill', 'data-pid': '4711' });
    expect(dialog.open).toBe(true);
    expect(getElementById('confirm-dialog-heading').textContent).toBe('Terminate PID 4711?');
    // whole sentences: every part ends with its own period (found in the Antigravity test)
    expect(getElementById('confirm-dialog-body').textContent).toBe(
      'node x-agent. No CPU or file activity for 50s. Its agent session ends. It gets SIGTERM first and SIGKILL only if it does not exit.',
    );
    await answer('cancel');
    expect(requests.filter((r) => r.init?.method === 'POST')).toEqual([]);

    click({ 'data-action': 'revert', 'data-path': 'src/a.ts' });
    await answer('confirm');
    expect(requests.filter((r) => r.init?.method === 'POST').map((r) => r.url)).toEqual(['/api/rollback-file']);
  });

  it('names the processes pause holds before it is confirmed, and resumes without a dialog', async () => {
    const { api, getElementById, requests } = loadDashboard();
    const procs = [
      { pid: 100, status: 'ACTIVE', category: 'agent', cmd: 'claude-code (opus)', memoryMb: 1, cpu: 1, inWatchedRepo: true, pauseTarget: true },
      { pid: 300, status: 'ACTIVE', category: 'node', cmd: 'node tsx watch server.ts', memoryMb: 1, cpu: 1, inWatchedRepo: true, pauseTarget: false },
    ];
    api.renderStatus(stateWith({ processes: procs }));
    const button = getElementById('pause-btn');
    expect(button.textContent).toBe('Pause agents');
    button.listeners.click?.[0]?.({});
    expect(getElementById('confirm-dialog-heading').textContent).toBe('Pause 1 process?');
    const body = getElementById('confirm-dialog-body').textContent;
    expect(body).toContain('PID 100 (claude-code (opus))');
    expect(body).not.toContain('PID 300');
    expect(body).toContain('Nothing is terminated and no file is touched');
    expect(requests.filter((r) => r.init?.method === 'POST')).toEqual([]);

    // while something is held, the same button continues it, without asking
    api.renderStatus(stateWith({ processes: [{ ...procs[0], paused: true }, procs[1]] }));
    expect(button.textContent).toBe('Resume agents');
    expect(getElementById('process-list').innerHTML).toContain('PAUSED');
    await button.listeners.click?.[0]?.({});
    expect(requests.filter((r) => r.init?.method === 'POST').map((r) => r.url)).toEqual(['/api/resume']);
  });

  it('offers revert on changes and alarms, not on a line that reports a rollback', () => {
    const { api, getElementById } = loadDashboard();
    api.renderStatus(
      stateWith({
        events: [
          { id: '1', type: 'file-edit', severity: 'info', timestamp: 0, filePath: 'a.ts', message: 'CHANGE: a.ts' },
          { id: '2', type: 'rollback', severity: 'warn', timestamp: 0, filePath: 'b.ts', message: 'Rolled back b.ts' },
        ],
      }),
    );
    const markup = getElementById('activity-list').innerHTML;
    expect(markup).toContain('data-path="a.ts"');
    expect(markup).not.toContain('data-path="b.ts"');
  });

  it('sends the token with every state-changing request', async () => {
    const { api, requests } = loadDashboard();
    await api.killProcess(4711);

    const posts = requests.filter((r) => r.init?.method === 'POST');
    expect(posts.map((r) => r.url)).toEqual(['/api/kill/4711']);
    for (const post of posts) {
      expect(post.init?.headers?.['X-Leash-Token']).toBe('token-from-meta');
    }
  });

  it('shows the hard stop instead of the usual limits', () => {
    const { api, getElementById } = loadDashboard();
    api.renderStatus(stateWith({ limitState: 'hard-stop', modifiedFiles: new Array(41).fill('f.ts') }));
    expect(getElementById('metric-files').textContent).toBe('41');
    expect(getElementById('metric-files').className).toContain('text-red-400');
    expect(getElementById('metric-files-limit').textContent).toContain('HARD STOP');
  });

  // Known gap: the behavior is not decided yet (AGENTS.md, section 6)
  it.todo('works without any request to a third party (Tailwind is loaded from a CDN today)');
});
