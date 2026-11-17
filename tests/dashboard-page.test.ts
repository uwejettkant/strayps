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
      return { ok: true, status: 200, json: async () => ({ ok: true, status: null, killedPids: [], restoredCount: 0 }) };
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
    setMode: (mode: string) => Promise<void>;
    killProcess: (pid: number) => Promise<void>;
  };
  return { api, elements, getElementById, requests, documentListeners };
}

const HOSTILE = `<img src=x onerror="fetch('/api/panic',{method:'POST'})">`;

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: '/work/repo',
    config: {
      mode: 'balanced',
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
            safety: 'safe-to-kill',
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
          { pid: `1); alert(1); (`, status: 'ACTIVE', safety: 'active-repo', category: 'agent', cmd: 'claude', memoryMb: 1, cpu: 0, inWatchedRepo: true },
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

  it('labels a process by where it really runs', () => {
    const { api, getElementById } = loadDashboard();
    const proc = { status: 'ACTIVE', safety: 'active-repo', category: 'agent', cmd: 'claude', memoryMb: 1, cpu: 1 };
    api.renderStatus(
      stateWith({ processes: [{ ...proc, pid: 1, inWatchedRepo: true }, { ...proc, pid: 2, inWatchedRepo: false }] }),
    );
    const markup = getElementById('process-list').innerHTML;
    expect(markup.match(/ACTIVE IN REPO/g)).toHaveLength(1);
    expect(markup.match(/OTHER SESSION/g)).toHaveLength(1);
  });

  it('sends the token with every state-changing request', async () => {
    const { api, requests } = loadDashboard();
    await api.setMode('strict');
    await api.killProcess(4711);

    const posts = requests.filter((r) => r.init?.method === 'POST');
    expect(posts.map((r) => r.url)).toEqual(['/api/mode', '/api/kill/4711']);
    for (const post of posts) {
      expect(post.init?.headers?.['X-Leash-Token']).toBe('token-from-meta');
    }
    expect(posts[0].init?.body).toBe('{"mode":"strict"}');
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
