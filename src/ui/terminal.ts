import type { StatusSnapshot, WatchdogSession } from '../core/session.js';
import { completeInput, HELP_LINES, parseCommand, runCommand } from './commands.js';
import {
  createPalette,
  formatClock,
  padEnd,
  padStart,
  type Palette,
  processTotals,
  sanitize,
  severityStyle,
  statusStyle,
  type Style,
  tildify,
  truncateStart,
  whereLabel,
} from './format.js';

// --- Frame rendering (pure) -------------------------------------------------------------------

interface Seg {
  text: string;
  style?: Style;
}

const seg = (text: string, style?: Style): Seg => ({ text, style });

function segLength(segs: Seg[]): number {
  return segs.reduce((n, s) => n + Array.from(s.text).length, 0);
}

/** Serializes segments, cutting the visible text at `cols` so a line can never wrap. */
function paint(segs: Seg[], cols: number): string {
  let remaining = cols;
  let out = '';
  for (const part of segs) {
    if (remaining <= 0) break;
    const chars = Array.from(part.text);
    let text = part.text;
    if (chars.length > remaining) {
      text = remaining > 1 ? `${chars.slice(0, remaining - 1).join('')}…` : '…';
      remaining = 0;
    } else {
      remaining -= chars.length;
    }
    out += part.style ? part.style(text) : text;
  }
  return out;
}

function leftRight(left: Seg[], right: Seg[], cols: number): Seg[] {
  const gap = cols - segLength(left) - segLength(right);
  if (gap < 2) return left;
  return [...left, seg(' '.repeat(gap)), ...right];
}

function padCell(segs: Seg[], width: number): Seg[] {
  const len = segLength(segs);
  return [...segs, seg(' '.repeat(Math.max(2, width - len)))];
}

export interface FrameNotice {
  text: string;
  level: 'info' | 'warn' | 'error';
}

export interface FrameView {
  snapshot: StatusSnapshot;
  cols: number;
  rows: number;
  version: string;
  dashboardUrl: string | null;
  demo: boolean;
  input: string;
  notice: FrameNotice | null;
  confirmPrompt: string | null;
  /** Full-height view replacing the normal body until the next key press. */
  overlay: 'help' | 'processes' | null;
  palette: Palette;
  now: number;
}

export interface Frame {
  /** Exactly `rows` lines, none wider than `cols` visible characters. */
  lines: string[];
  /** 1-based cursor position inside the input line. */
  cursor: { row: number; col: number };
}

function metricCells(view: FrameView): Seg[][] {
  const { snapshot, palette: p } = view;
  const { config } = snapshot;
  const totals = processTotals(snapshot.processes);

  const fileCount = snapshot.modifiedFiles.length;
  const filesStyle =
    snapshot.limitState === 'hard-stop' ? p.danger : snapshot.limitState === 'warn' ? p.warn : p.strong;
  const files: Seg[] = [
    seg(' FILES      ', p.dim),
    seg(`${fileCount} modified`, filesStyle),
    snapshot.limitState === 'hard-stop'
      ? seg('  HARD STOP limit reached', p.danger)
      : seg(`  warn ${config.limits.maxFilesWarn} · stop ${config.limits.maxFilesHardStop}`, p.dim),
  ];

  const tripped = snapshot.trippedFiles;
  const breaker: Seg[] =
    tripped.length > 0
      ? [
          seg(' BREAKER    ', p.dim),
          seg(`TRIPPED (${tripped.length})`, p.danger),
          seg(`  ${tripped.map(sanitize).join(', ')}`, p.warn),
        ]
      : [
          seg(' BREAKER    ', p.dim),
          seg('armed', p.ok),
          seg(`  max ${config.limits.maxEditsPerFilePerMinute} edits/file/min`, p.dim),
        ];

  const procs: Seg[] = [
    seg(' PROCESSES  ', p.dim),
    seg(`${totals.count} monitored`, p.strong),
    totals.staleCount > 0
      ? seg(`  ${totals.staleCount} stale/frozen · ${totals.staleMb.toFixed(0)} MB`, p.warn)
      : seg(`  none stale · ${totals.totalMb.toFixed(0)} MB total`, p.dim),
  ];

  const cp = snapshot.checkpoint;
  const checkpoint: Seg[] = [
    seg(' CHECKPOINT ', p.dim),
    cp
      ? seg(`${sanitize(cp.ref)}`, p.strong)
      : seg('initializing…', p.dim),
    cp ? seg(`  ${cp.type}, ${cp.snapshottedFiles} files`, p.dim) : seg(''),
  ];

  return [files, breaker, procs, checkpoint];
}

function compactMetrics(view: FrameView): Seg[] {
  const { snapshot, palette: p } = view;
  const totals = processTotals(snapshot.processes);
  const fileStyle =
    snapshot.limitState === 'hard-stop' ? p.danger : snapshot.limitState === 'warn' ? p.warn : p.plain;
  return [
    seg(` ${snapshot.modifiedFiles.length} files`, fileStyle),
    snapshot.limitState === 'hard-stop' ? seg(' HARD STOP', p.danger) : seg(''),
    seg(' · '),
    snapshot.trippedFiles.length > 0
      ? seg(`breaker TRIPPED (${snapshot.trippedFiles.length})`, p.danger)
      : seg('breaker armed', p.ok),
    seg(` · ${totals.count} procs`),
    totals.staleCount > 0
      ? seg(` (${totals.staleCount} stale, ${totals.staleMb.toFixed(0)} MB)`, p.warn)
      : seg(''),
  ];
}

function activityRows(view: FrameView, count: number): Seg[][] {
  const { snapshot, palette: p } = view;
  if (count <= 0) return [];
  if (snapshot.events.length === 0) {
    return [[seg('   No activity yet — waiting for file changes…', p.dim)]];
  }
  // Snapshot events are newest first; a terminal log reads oldest to newest.
  const shown = snapshot.events.slice(0, count).reverse();
  return shown.map((event) => [
    seg(` ${formatClock(event.timestamp)}  `, p.dim),
    seg(padEnd(event.type, 19), severityStyle(p, event.severity)),
    seg(sanitize(event.message), event.severity === 'info' ? p.plain : severityStyle(p, event.severity)),
  ]);
}

function processRows(view: FrameView, count: number): Seg[][] {
  const { snapshot, palette: p } = view;
  if (count <= 0) return [];
  const procs = snapshot.processes;
  if (procs.length === 0) {
    return [[seg('   No agent or MCP processes found.', p.dim)]];
  }

  const header: Seg[] = [
    seg(
      ` ${padEnd('PID', 7)} ${padEnd('STATUS', 8)} ${padEnd('WHERE', 13)} ${padStart('RAM', 9)} ${padStart('AGE', 8)} ${padStart('CPU', 6)}  COMMAND · CWD`,
      p.dim,
    ),
  ];
  const row = (proc: (typeof procs)[number]): Seg[] => {
    const where = proc.cwd ? ` · ${sanitize(proc.cwd)}` : '';
    const host = proc.host && proc.host !== 'detached' ? ` [${sanitize(proc.host)}]` : '';
    return [
      seg(` ${padEnd(String(proc.pid), 7)} `, p.strong),
      seg(padEnd(proc.status, 8), statusStyle(p, proc)),
      seg(` ${padEnd(whereLabel(proc), 13)}`, p.dim),
      seg(
        ` ${padStart(`${proc.memoryMb.toFixed(1)} MB`, 9)} ${padStart(sanitize(proc.uptime), 8)} ${padStart(`${proc.cpu.toFixed(1)}%`, 6)}  `,
      ),
      seg(sanitize(proc.cmd)),
      seg(`${where}${host}`, p.dim),
    ];
  };
  const more = (hidden: number): Seg[] => [
    seg(`   … ${hidden} more — type status to list all`, p.dim),
  ];

  // Everything fits: header plus one row per process
  if (count >= procs.length + 1) {
    return [header, ...procs.map(row)];
  }
  // Tight: real rows matter more than the column header
  if (count === 1) {
    return [more(procs.length)];
  }
  const withHeader = count >= 4;
  const rowCount = count - 1 - (withHeader ? 1 : 0);
  return [
    ...(withHeader ? [header] : []),
    ...procs.slice(0, rowCount).map(row),
    more(procs.length - rowCount),
  ];
}

function processOverlayRows(view: FrameView, available: number): Seg[][] {
  const p = view.palette;
  const totals = processTotals(view.snapshot.processes);
  const rows: Seg[][] = [
    [
      seg(' ALL PROCESSES', p.strong),
      seg(
        `  ${totals.count} monitored · ${totals.totalMb.toFixed(0)} MB · ${totals.staleCount} stale/frozen (${totals.staleMb.toFixed(0)} MB)`,
        p.dim,
      ),
    ],
  ];
  rows.push(...processRows(view, Math.max(2, available - 3)));
  while (rows.length < available - 1) rows.push([seg('')]);
  rows.push([seg(' Press any key to return.', p.dim)]);
  return rows;
}

function helpRows(view: FrameView): Seg[][] {
  const p = view.palette;
  const rows: Seg[][] = [[seg(' COMMANDS', p.strong)]];
  for (const [usage, description] of HELP_LINES) {
    rows.push([seg(`   ${padEnd(usage, 30)}`, p.accent), seg(description)]);
  }
  rows.push([seg('')]);
  rows.push([seg(' KEYS', p.strong)]);
  rows.push([
    seg('   Tab complete · ↑/↓ history · Ctrl+U clear line · Ctrl+L redraw · Esc cancel · Ctrl+C exit'),
  ]);
  rows.push([seg('')]);
  rows.push([
    seg(' Destructive commands (revert, kill, panic) always ask before they act.', p.dim),
  ]);
  rows.push([seg(' Press any key to return.', p.dim)]);
  return rows;
}

/**
 * Renders the whole screen for the given state. Pure: same input, same lines.
 */
export function renderFrame(view: FrameView): Frame {
  const { snapshot, palette: p } = view;
  const cols = Math.max(20, view.cols);
  const rows = Math.max(6, view.rows);
  const body: Seg[][] = [];

  // --- Header ---
  const clock: Seg[] = [seg(`${formatClock(view.now)} `, p.dim)];
  const titleStart: Seg[] = [
    seg(` agent-leash v${view.version}`, p.accent),
    view.demo ? seg('  DEMO — simulated, nothing is touched', p.warn) : seg(''),
    seg('  watching ', p.dim),
  ];
  // The path gives way to the clock; its tail (the repo name) is the part worth keeping.
  const pathRoom = cols - segLength(titleStart) - segLength(clock) - 2;
  const repoPath = sanitize(tildify(snapshot.rootDir));
  const title: Seg[] = [
    ...titleStart,
    seg(pathRoom >= 12 ? truncateStart(repoPath, pathRoom) : repoPath, p.strong),
  ];
  const header: Seg[][] = [
    leftRight(title, clock, cols),
    [
      view.dashboardUrl
        ? seg(` dashboard ${view.dashboardUrl}`, p.dim)
        : seg(' dashboard off', p.dim),
    ],
    [seg('─'.repeat(cols), p.dim)],
  ];

  // --- Footer ---
  let noticeLine: Seg[];
  if (view.confirmPrompt) {
    noticeLine = [seg(` ? ${view.confirmPrompt} `, p.warn), seg('[y/N]', p.strong)];
  } else if (view.notice?.text) {
    const style =
      view.notice.level === 'error' ? p.danger : view.notice.level === 'warn' ? p.warn : p.ok;
    noticeLine = [seg(` ${view.notice.text}`, style)];
  } else {
    noticeLine = [seg(' Type a command and press Enter — help lists them, exit stops the watchdog.', p.dim)];
  }
  const prompt = ' › ';
  const hint = 'help · exit · Ctrl+C ';
  const inputRoom = Math.max(4, cols - prompt.length - 1);
  const inputChars = Array.from(view.input);
  const shownInput =
    inputChars.length > inputRoom ? inputChars.slice(inputChars.length - inputRoom).join('') : view.input;
  const inputLine = leftRight(
    [seg(prompt, p.accent), seg(view.confirmPrompt ? '' : shownInput)],
    [seg(hint, p.dim)],
    cols,
  );
  const footer: Seg[][] = [[seg('─'.repeat(cols), p.dim)], noticeLine, inputLine];

  const available = rows - header.length - footer.length;

  if (view.overlay === 'help') {
    body.push(...helpRows(view).slice(0, Math.max(0, available)));
  } else if (view.overlay === 'processes') {
    body.push(...processOverlayRows(view, available));
  } else if (available < 8 || cols < 60) {
    // Small terminal: one status line and the newest events
    if (available >= 1) {
      body.push(compactMetrics(view));
    }
    body.push(...activityRows(view, available - 1));
  } else {
    const cells = metricCells(view);
    let metrics: Seg[][] =
      cols >= 104
        ? [
            [...padCell(cells[0], Math.floor(cols / 2)), ...cells[1]],
            [...padCell(cells[2], Math.floor(cols / 2)), ...cells[3]],
          ]
        : cells;
    // Short terminal: the lists matter more than four metric lines
    if (available - metrics.length - 4 < 8) {
      metrics = [compactMetrics(view)];
    }

    const totals = processTotals(snapshot.processes);
    // metrics + blank + two section titles + blank between sections
    const chrome = metrics.length + 1 + 1 + 1 + 1;
    const flexible = Math.max(2, available - chrome);
    const wantedProcRows =
      snapshot.processes.length === 0 ? 1 : snapshot.processes.length + 1;
    const procRowCount = Math.min(wantedProcRows, Math.max(2, Math.floor(flexible / 2)));
    const activityRowCount = Math.max(1, flexible - procRowCount);

    body.push(...metrics);
    body.push([seg('')]);
    body.push([
      seg(' ACTIVITY', p.strong),
      seg(
        snapshot.events.length > activityRowCount
          ? `  newest ${activityRowCount} of ${snapshot.events.length}`
          : `  ${snapshot.events.length} event${snapshot.events.length === 1 ? '' : 's'}`,
        p.dim,
      ),
    ]);
    const activity = activityRows(view, activityRowCount);
    body.push(...activity);
    for (let i = activity.length; i < activityRowCount; i++) body.push([seg('')]);
    body.push([seg('')]);
    body.push([
      seg(' PROCESSES', p.strong),
      seg(`  ${totals.count} monitored · ${totals.totalMb.toFixed(0)} MB`, p.dim),
    ]);
    body.push(...processRows(view, procRowCount));
  }

  const lines: string[] = [];
  for (const line of header) lines.push(paint(line, cols));
  for (const line of body.slice(0, Math.max(0, available))) lines.push(paint(line, cols));
  while (lines.length < rows - footer.length) lines.push('');
  for (const line of footer) lines.push(paint(line, cols));

  const cursorCol = view.confirmPrompt
    ? Math.min(cols, Array.from(` ? ${view.confirmPrompt} [y/N]`).length + 2)
    : Math.min(cols, prompt.length + Array.from(shownInput).length + 1);
  const cursorRow = view.confirmPrompt ? rows - 1 : rows;

  return { lines: lines.slice(0, rows), cursor: { row: cursorRow, col: cursorCol } };
}

// --- Interactive controller ---------------------------------------------------------------------

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown;
  off: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown;
}

export interface TtyOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (data: string) => unknown;
  on: (event: 'resize', listener: () => void) => unknown;
  off: (event: 'resize', listener: () => void) => unknown;
}

export interface TerminalUIOptions {
  session: WatchdogSession;
  stdin: TtyInput;
  stdout: TtyOutput;
  version: string;
  dashboardUrl?: string | null;
  demo?: boolean;
  color?: boolean;
  truecolor?: boolean;
  /** Called once when the user asks to quit (exit command, Ctrl+C, Ctrl+D). */
  onExit: (reason: 'command' | 'ctrl-c' | 'ctrl-d') => void;
}

const ESC = '\u001b';
const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?7l${ESC}[2J${ESC}[H`;
const LEAVE_SCREEN = `${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
const RENDER_INTERVAL_MS = 40;

/**
 * Full-screen live view of the watchdog with a command line at the bottom.
 * Shows what the web dashboard shows and offers the same actions, from the same session.
 */
export class TerminalUI {
  private readonly session: WatchdogSession;
  private readonly stdin: TtyInput;
  private readonly stdout: TtyOutput;
  private readonly palette: Palette;
  private readonly options: TerminalUIOptions;

  private active = false;
  private exitRequested = false;
  private input = '';
  private notice: FrameNotice | null = null;
  private confirm: { prompt: string; run: () => ReturnType<typeof runCommand> } | null = null;
  private overlay: 'help' | 'processes' | null = null;
  private history: string[] = [];
  private historyIndex = -1;
  private renderTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  private readonly onData = (chunk: string | Buffer) => this.handleInput(chunk.toString());
  private readonly onResize = () => this.renderNow();
  private readonly onUpdate = () => this.requestRender();

  constructor(options: TerminalUIOptions) {
    this.options = options;
    this.session = options.session;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.palette = createPalette(options.color ?? true, options.truecolor ?? false);
  }

  public isActive(): boolean {
    return this.active;
  }

  public start(): void {
    if (this.active) return;
    this.active = true;
    this.stdin.setRawMode?.(true);
    this.stdin.setEncoding?.('utf8');
    this.stdin.resume();
    this.stdin.on('data', this.onData);
    this.stdout.on('resize', this.onResize);
    this.session.on('update', this.onUpdate);
    this.session.on('event', this.onUpdate);
    this.stdout.write(ENTER_SCREEN);
    this.tickTimer = setInterval(() => this.requestRender(), 1000);
    this.tickTimer.unref();
    this.renderNow();
  }

  /** Restores the terminal. Safe to call more than once and from exit handlers. */
  public stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.renderTimer = null;
    this.tickTimer = null;
    this.session.off('update', this.onUpdate);
    this.session.off('event', this.onUpdate);
    this.stdout.off('resize', this.onResize);
    this.stdin.off('data', this.onData);
    try {
      this.stdin.setRawMode?.(false);
    } catch {
      // The terminal may already be gone
    }
    this.stdin.pause();
    this.stdout.write(LEAVE_SCREEN);
  }

  private requestRender(): void {
    if (!this.active || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderNow();
    }, RENDER_INTERVAL_MS);
    this.renderTimer.unref();
  }

  public renderNow(): void {
    if (!this.active) return;
    const frame = renderFrame({
      snapshot: this.session.getSnapshot(),
      cols: this.stdout.columns ?? 80,
      rows: this.stdout.rows ?? 24,
      version: this.options.version,
      dashboardUrl: this.options.dashboardUrl ?? null,
      demo: this.options.demo ?? false,
      input: this.input,
      notice: this.notice,
      confirmPrompt: this.confirm?.prompt ?? null,
      overlay: this.overlay,
      palette: this.palette,
      now: Date.now(),
    });
    // One write per frame; synchronized-output markers avoid tearing where supported.
    this.stdout.write(
      `${ESC}[?2026h${ESC}[?25l${ESC}[H${frame.lines.join(`${ESC}[K\r\n`)}${ESC}[K${ESC}[${frame.cursor.row};${frame.cursor.col}H${ESC}[?25h${ESC}[?2026l`,
    );
  }

  /** Feeds raw terminal input (keys, pasted text, escape sequences) into the UI. */
  public handleInput(chunk: string): void {
    if (!this.active) return;
    let i = 0;
    while (i < chunk.length && this.active) {
      const ch = chunk[i];
      if (ch === ESC) {
        const next = chunk[i + 1];
        if (next === '[' || next === 'O') {
          let j = i + 2;
          while (j < chunk.length) {
            const code = chunk.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
          }
          this.handleEscapeSequence(chunk.slice(i, j + 1));
          i = j + 1;
          continue;
        }
        this.handleKey('escape');
        i += 1;
        continue;
      }
      // Surrogate pairs (emoji etc.) arrive as two UTF-16 code units
      const codePoint = chunk.codePointAt(i) ?? 0;
      const char = String.fromCodePoint(codePoint);
      this.handleChar(char, codePoint);
      i += char.length;
    }
    this.requestRender();
  }

  private handleEscapeSequence(sequence: string): void {
    if (this.dismissOverlay()) return;
    if (this.confirm) {
      this.cancelConfirm();
      return;
    }
    if (sequence === `${ESC}[A` || sequence === `${ESC}OA`) {
      if (this.history.length === 0) return;
      this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
      this.input = this.history[this.historyIndex];
    } else if (sequence === `${ESC}[B` || sequence === `${ESC}OB`) {
      this.historyIndex = Math.max(-1, this.historyIndex - 1);
      this.input = this.historyIndex === -1 ? '' : this.history[this.historyIndex];
    }
    // Everything else (cursor keys, function keys, mouse reports) is ignored
  }

  private handleKey(key: 'escape'): void {
    if (this.dismissOverlay()) return;
    if (this.confirm) {
      this.cancelConfirm();
      return;
    }
    if (key === 'escape') {
      this.input = '';
      this.notice = null;
    }
  }

  private handleChar(char: string, code: number): void {
    // Ctrl+C always quits, whatever state the UI is in
    if (code === 0x03) {
      this.requestExit('ctrl-c');
      return;
    }
    if (this.dismissOverlay()) return;

    if (this.confirm) {
      const pending = this.confirm;
      this.confirm = null;
      if (char === 'y' || char === 'Y') {
        this.applyResult(pending.run());
      } else {
        this.notice = { text: 'Cancelled — nothing was changed', level: 'info' };
      }
      return;
    }

    if (code === 0x04) {
      // Ctrl+D on an empty line quits, like a shell
      if (this.input.length === 0) this.requestExit('ctrl-d');
      return;
    }
    if (code === 0x0d || code === 0x0a) {
      this.submit();
      return;
    }
    if (code === 0x7f || code === 0x08) {
      this.input = Array.from(this.input).slice(0, -1).join('');
      return;
    }
    if (code === 0x15) {
      this.input = '';
      return;
    }
    if (code === 0x17) {
      this.input = this.input.replace(/\S*\s*$/, '');
      return;
    }
    if (code === 0x0c) {
      this.stdout.write(`${ESC}[2J`);
      return;
    }
    if (code === 0x09) {
      const completion = completeInput(this.session, this.input);
      this.input = completion.input;
      this.notice =
        completion.candidates.length > 0
          ? { text: completion.candidates.map(sanitize).join('   '), level: 'info' }
          : null;
      return;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return; // other control characters
    }
    if (Array.from(this.input).length < 512) {
      this.input += char;
    }
  }

  private dismissOverlay(): boolean {
    if (!this.overlay) return false;
    this.overlay = null;
    return true;
  }

  private cancelConfirm(): void {
    this.confirm = null;
    this.notice = { text: 'Cancelled — nothing was changed', level: 'info' };
  }

  private submit(): void {
    const line = this.input.trim();
    this.input = '';
    this.historyIndex = -1;
    if (!line) {
      this.notice = null;
      return;
    }
    if (this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > 50) this.history.length = 50;
    }
    this.applyResult(runCommand(this.session, parseCommand(line)));
  }

  private applyResult(result: ReturnType<typeof runCommand>): void {
    if (result.exit) {
      this.requestExit('command');
      return;
    }
    if (result.confirm) {
      this.confirm = result.confirm;
      this.notice = null;
      return;
    }
    if (result.showHelp) {
      this.overlay = 'help';
      this.notice = null;
      return;
    }
    if (result.showStatus) {
      this.overlay = 'processes';
      this.notice = null;
      return;
    }
    this.notice = result.message ? { text: result.message, level: result.level } : null;
  }

  private requestExit(reason: 'command' | 'ctrl-c' | 'ctrl-d'): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.notice = { text: 'Shutting down…', level: 'info' };
    this.options.onExit(reason);
  }
}
