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
  const script = html.match(/<script nonce="__STRAYPS_NONCE__">([\s\S]*?)<\/script>/)?.[1];
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
    content: '',
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
      querySelector: () => null,
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
  };
  return { api, elements, getElementById, requests, documentListeners };
}

const HOSTILE = `<img src=x onerror="fetch('/api/panic',{method:'POST'})">`;

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: '/work/repo',
    config: { agents: [], limits: { mcpSilenceTimeoutSec: 45, staleSessionHours: 6 } },
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
    expect(scripts).toEqual(['<script nonce="__STRAYPS_NONCE__">']);
    expect(html.match(/<style\b[^>]*>/g)).toEqual(['<style nonce="__STRAYPS_NONCE__">']);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toContain('v0.1.0');
  });

  it('is a view only: no token, no buttons, no dialogs, and its script only reads', async () => {
    // the page held the token for the kill route, and any local process could load the page
    expect(html).not.toContain('leash-token');
    expect(html).not.toContain('__STRAYPS_TOKEN__');
    expect(html).not.toMatch(/<(button|dialog|form|input|textarea)\b/i);
    expect(html).not.toContain('data-action');
    expect(html).toContain('use the terminal');

    const { api, requests, documentListeners } = loadDashboard();
    api.renderStatus(
      stateWith({
        processes: [{ pid: 4711, status: 'FROZEN', category: 'agent', cmd: 'claude', memoryMb: 1, cpu: 0, inWatchedRepo: false }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(documentListeners.click ?? []).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual(['/api/status']);
    expect(requests.every((r) => (r.init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('escapes every character that could start markup', () => {
    const { api } = loadDashboard();
    expect(api.esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(api.esc(undefined)).toBe('');
    expect(api.esc(0)).toBe('0');
  });

  it('renders hostile event messages, types and severities as text', () => {
    const { api, getElementById } = loadDashboard();
    api.renderStatus(
      stateWith({
        events: [
          { id: '1', type: 'process-alert', severity: 'warn', timestamp: 0, message: `PID 7 ${HOSTILE}` },
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
    expect(markup).toContain('PID 4711');
    // a PID that is not a number can never become one in the markup
    expect(markup).toContain('PID 0');
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
          { ...proc, pid: 4, inWatchedRepo: true, pauseTarget: true, paused: true },
        ],
      }),
    );
    const markup = getElementById('process-list').innerHTML;
    expect(markup.match(/THIS REPO/g)).toHaveLength(2);
    expect(markup.match(/ELSEWHERE/g)).toHaveLength(1);
    expect(markup.match(/DETACHED/g)).toHaveLength(1);
    expect(markup.match(/AGENT TREE/g)).toHaveLength(1);
    expect(markup.match(/PAUSED/g)).toHaveLength(1);
    expect(markup).not.toMatch(/safe to kill|kill stale/i);
    expect(getElementById('metric-silence-limit').textContent).not.toMatch(/safe to kill|reclaimable/i);
  });

  it('counts agent sessions, MCP servers and what is left behind, with their memory', () => {
    const { api, getElementById } = loadDashboard();
    api.renderStatus(
      stateWith({
        config: { agents: ['vibe'], limits: { mcpSilenceTimeoutSec: 45, staleSessionHours: 9 } },
        processes: [
          { pid: 1, status: 'ACTIVE', category: 'agent', cmd: 'claude', memoryMb: 300, memorySource: 'footprint', cpu: 1, inWatchedRepo: true },
          { pid: 2, status: 'STALE', category: 'agent', cmd: 'claude', memoryMb: 120, memorySource: 'footprint', cpu: 0, inWatchedRepo: false },
          { pid: 3, status: 'STANDBY', category: 'mcp', cmd: 'node mcp-server-git', memoryMb: 25, memorySource: 'footprint', cpu: 0, inWatchedRepo: false },
          // RSS, where the footprint could not be read: only approximate, and so is every sum with it
          { pid: 4, status: 'FROZEN', category: 'mcp', cmd: 'node mcp-server-fetch', memoryMb: 30, memorySource: 'rss', cpu: 0, inWatchedRepo: false },
        ],
      }),
    );
    expect(getElementById('metric-agents').textContent).toBe('2');
    expect(getElementById('metric-agents-mb').textContent).toBe('420 MB');
    expect(getElementById('metric-mcp').textContent).toBe('2');
    expect(getElementById('metric-mcp-mb').textContent).toBe('~55 MB');
    expect(getElementById('metric-procs').textContent).toBe('2');
    expect(getElementById('metric-frozen').textContent).toBe('stale/frozen · ~150 MB');
    const rows = getElementById('process-list').innerHTML;
    expect(rows).toContain('>300.0 MB<');
    expect(rows).toContain('>~30.0 MB<');
    expect(getElementById('metric-silence-limit').textContent).toContain('older than 9h');
    expect(getElementById('agent-names').textContent).toBe('vibe');

    api.renderStatus(stateWith());
    expect(getElementById('metric-frozen').textContent).toBe('none seen · 0 MB monitored');
    expect(getElementById('activity-list').innerHTML).toContain('No activity yet');
  });
});
