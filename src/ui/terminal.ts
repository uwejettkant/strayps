import { formatMemory, sumMemory } from '../core/process-monitor.js';
import type { StatusSnapshot, MonitorSession } from '../core/session.js';
import { type CommandResult, completeInput, HELP_LINES, parseCommand, runCommand } from './commands.js';
import {
  createPalette,
  formatClock,
  padEnd,
  padStart,
  type Palette,
  processTotals,
  rowText,
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
  /** Lines naming everything the open question affects, shown in full instead of the body. */
  confirmDetails?: string[] | null;
  /** What yes does to the listed processes; the wording follows it. */
  confirmEffect?: 'end' | 'hold';
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
  /** Lines of the open question that did not fit the screen; the question is not answerable then. */
  hiddenConfirmDetails: number;
}

function metricCells(view: FrameView): Seg[][] {
  const { snapshot, palette: p } = view;
  const totals = processTotals(snapshot.processes);
  const agents = snapshot.processes.filter((proc) => proc.category === 'agent');
  const mcp = snapshot.processes.filter((proc) => proc.category === 'mcp');
  const paused = snapshot.processes.filter((proc) => proc.paused).length;

  const agentCell: Seg[] = [
    seg(' AGENTS     ', p.dim),
    seg(`${agents.length} session${agents.length === 1 ? '' : 's'}`, p.strong),
    seg(`  ${sumMemory(agents)}`, p.dim),
  ];
  const mcpCell: Seg[] = [
    seg(' MCP        ', p.dim),
    seg(`${mcp.length} server${mcp.length === 1 ? '' : 's'}`, p.strong),
    seg(`  ${sumMemory(mcp)}`, p.dim),
  ];
  const leftCell: Seg[] = [
    seg(' LEFT BEHIND', p.dim),
    totals.staleCount > 0
      ? seg(` ${totals.staleCount} stale/frozen · ${totals.stale}`, p.warn)
      : seg(' none seen', p.ok),
  ];
  const pausedCell: Seg[] = [
    seg(' PAUSED     ', p.dim),
    paused > 0 ? seg(`${paused} held — resume continues them`, p.warn) : seg('nothing held', p.dim),
  ];
  return [agentCell, mcpCell, leftCell, pausedCell];
}

function compactMetrics(view: FrameView): Seg[] {
  const { snapshot, palette: p } = view;
  const totals = processTotals(snapshot.processes);
  const agents = snapshot.processes.filter((proc) => proc.category === 'agent').length;
  const mcp = snapshot.processes.filter((proc) => proc.category === 'mcp').length;
  const paused = snapshot.processes.filter((proc) => proc.paused).length;
  return [
    seg(` ${agents} agents · ${mcp} MCP`),
    totals.staleCount > 0
      ? seg(` · ${totals.staleCount} stale/frozen (${totals.stale})`, p.warn)
      : seg(''),
    paused > 0 ? seg(` · ${paused} paused`, p.warn) : seg(''),
  ];
}

function activityRows(view: FrameView, count: number): Seg[][] {
  const { snapshot, palette: p } = view;
  if (count <= 0) return [];
  if (snapshot.events.length === 0) {
    return [[seg('   No activity yet — watching the agent and MCP processes…', p.dim)]];
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

  const cols = Math.max(20, view.cols);
  const memory = (proc: (typeof procs)[number]) =>
    formatMemory(proc.memoryMb, proc.memorySource !== 'footprint');
  // Below this the wide layout leaves the command fewer than 16 characters: then the narrow one
  // drops WHERE, AGE and CPU (scenario pass, 20.11.2026: at 58 columns no row said which program)
  const narrow = cols < 79;
  const header: Seg[] = [
    seg(
      narrow
        ? ` ${padEnd('PID', 7)} ${padEnd('STATUS', 8)} ${padStart('RAM', 9)}  ${padEnd('KIND', 5)}  COMMAND · CWD`
        : ` ${padEnd('PID', 7)} ${padEnd('STATUS', 8)} ${padEnd('WHERE', 10)} ${padStart('RAM', 9)} ${padStart('AGE', 8)} ${padStart('CPU', 6)}  ${padEnd('KIND', 5)}  COMMAND · CWD`,
      p.dim,
    ),
  ];
  const row = (proc: (typeof procs)[number]): Seg[] => {
    const start: Seg[] = [
      seg(` ${padEnd(String(proc.pid), 7)} `, p.strong),
      seg(padEnd(proc.paused ? 'PAUSED' : proc.status, 8), proc.paused ? p.warn : statusStyle(p, proc)),
      ...(narrow
        ? [seg(` ${padStart(memory(proc), 9)}  `)]
        : [
            seg(` ${padEnd(whereLabel(proc), 10)}`, p.dim),
            seg(
              ` ${padStart(memory(proc), 9)} ${padStart(sanitize(proc.uptime), 8)} ${padStart(`${proc.cpu.toFixed(1)}%`, 6)}  `,
            ),
          ]),
      seg(`${padEnd(proc.category, 5)}  `, p.dim),
    ];
    const { command, rest } = rowText(proc, Math.max(1, cols - segLength(start)));
    return [...start, seg(command), seg(rest, p.dim)];
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
    return procs.length === 1 ? [row(procs[0])] : [more(procs.length)];
  }
  const withHeader = count >= 4;
  const rowCount = count - 1 - (withHeader ? 1 : 0);
  return [
    ...(withHeader ? [header] : []),
    ...procs.slice(0, rowCount).map(row),
    more(procs.length - rowCount),
  ];
}

/**
 * Splits `room` rows between the activity log and the process list. Neither keeps rows it cannot
 * fill while the other needs them; when both need more, the processes get the larger half
 * (scenario pass, 20.11.2026: blank log rows next to "… 3 more").
 */
function splitRows(view: FrameView, room: number): { activity: number; processes: number } {
  // One or two rows: the newest events, as before. A process list that small says only "… N
  // more", and the log can hold a warning that .strayps.json changed (safety review, 21.11.2026)
  if (room < 3) return { activity: Math.max(0, room), processes: 0 };
  const { processes, events } = view.snapshot;
  const wantedProcesses = processes.length === 0 ? 1 : processes.length + 1;
  const wantedActivity = Math.max(1, events.length);
  const activity = Math.min(wantedActivity, Math.floor(room / 2));
  const procRows = Math.min(wantedProcesses, room - activity);
  return { activity: room - procRows, processes: procRows };
}

function processOverlayRows(view: FrameView, available: number): Seg[][] {
  const p = view.palette;
  const totals = processTotals(view.snapshot.processes);
  const rows: Seg[][] = [
    [
      seg(' ALL PROCESSES', p.strong),
      seg(
        `  ${totals.count} monitored · ${totals.total} · ${totals.staleCount} stale/frozen (${totals.stale})`,
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
    seg(' Commands that change something (kill, pause) always ask before they act.', p.dim),
  ]);
  rows.push([
    seg(' Memory (RAM) is the physical footprint, as Activity Monitor shows it; ~ marks RSS, only approximate.', p.dim),
  ]);
  rows.push([seg(' Press any key to return.', p.dim)]);
  return rows;
}

/**
 * What the open question affects, one line each. When the lines do not fit, the question cannot be
 * answered with yes (TerminalUI refuses it): a person must see everything that ends.
 */
function confirmRows(view: FrameView, details: string[], available: number): { rows: Seg[][]; hidden: number } {
  const p = view.palette;
  const hold = view.confirmEffect === 'hold';
  const rows: Seg[][] = [[seg(hold ? ' HELD WHEN YOU ANSWER y' : ' ENDS WHEN YOU ANSWER y', p.strong)]];
  const room = Math.max(0, available - 3);
  const shown = details.length <= room ? details : details.slice(0, Math.max(0, room - 1));
  for (const line of shown) rows.push([seg(`   ${line}`, p.warn)]);
  const hidden = details.length - shown.length;
  rows.push([seg('')]);
  rows.push(
    hidden > 0
      ? [seg(` ${hidden} more do not fit: make the terminal taller to see them, or press any key to cancel`, p.danger)]
      : [seg(hold ? ' y holds them · any other key cancels' : ' y ends them · any other key cancels', p.dim)],
  );
  return { rows: rows.slice(0, Math.max(0, available)), hidden };
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
    seg(` strayps v${view.version}`, p.accent),
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
    noticeLine = [seg(' Type a command and press Enter — help lists them, exit stops strayps.', p.dim)];
  }
  const prompt = ' › ';
  const hint = 'help · exit · Ctrl+C ';
  const inputRoom = Math.max(4, cols - prompt.length - 1);
  // The input holds whatever was typed or pasted, and a paste can carry control sequences: they
  // must not reach the terminal
  const safeInput = sanitize(view.input);
  const inputChars = Array.from(safeInput);
  const shownInput =
    inputChars.length > inputRoom ? inputChars.slice(inputChars.length - inputRoom).join('') : safeInput;
  const inputLine = leftRight(
    [seg(prompt, p.accent), seg(view.confirmPrompt ? '' : shownInput)],
    [seg(hint, p.dim)],
    cols,
  );
  const footer: Seg[][] = [[seg('─'.repeat(cols), p.dim)], noticeLine, inputLine];

  const available = rows - header.length - footer.length;

  let hiddenConfirmDetails = 0;
  if (view.confirmPrompt && view.confirmDetails && view.confirmDetails.length > 0 && !view.overlay) {
    const confirm = confirmRows(view, view.confirmDetails, available);
    body.push(...confirm.rows);
    hiddenConfirmDetails = confirm.hidden;
  } else if (view.overlay === 'help') {
    body.push(...helpRows(view).slice(0, Math.max(0, available)));
  } else if (view.overlay === 'processes') {
    body.push(...processOverlayRows(view, available));
  } else if (available < 8 || cols < 60) {
    // Small terminal: one status line, the newest events and as many processes as fit
    if (available >= 1) {
      body.push(compactMetrics(view));
    }
    const split = splitRows(view, available - 1);
    body.push(...activityRows(view, split.activity));
    body.push(...processRows(view, split.processes));
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
    const split = splitRows(view, flexible);
    const procRowCount = Math.max(1, split.processes);
    const activityRowCount = Math.max(1, split.activity);

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
      seg(`  ${totals.count} monitored · ${totals.total}`, p.dim),
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

  return { lines: lines.slice(0, rows), cursor: { row: cursorRow, col: cursorCol }, hiddenConfirmDetails };
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
  session: MonitorSession;
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
 * Full-screen live view of strayps with a command line at the bottom.
 * Shows what the web dashboard shows, from the same session, and is where its actions are.
 */
export class TerminalUI {
  private readonly session: MonitorSession;
  private readonly stdin: TtyInput;
  private readonly stdout: TtyOutput;
  private readonly palette: Palette;
  private readonly options: TerminalUIOptions;

  private active = false;
  private exitRequested = false;
  private input = '';
  private notice: FrameNotice | null = null;
  private confirm: NonNullable<CommandResult['confirm']> | null = null;
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
    const frame = this.currentFrame();
    // One write per frame; synchronized-output markers avoid tearing where supported.
    this.stdout.write(
      `${ESC}[?2026h${ESC}[?25l${ESC}[H${frame.lines.join(`${ESC}[K\r\n`)}${ESC}[K${ESC}[${frame.cursor.row};${frame.cursor.col}H${ESC}[?25h${ESC}[?2026l`,
    );
  }

  private currentFrame(): Frame {
    return renderFrame({
      snapshot: this.session.getSnapshot(),
      cols: this.stdout.columns ?? 80,
      rows: this.stdout.rows ?? 24,
      version: this.options.version,
      dashboardUrl: this.options.dashboardUrl ?? null,
      demo: this.options.demo ?? false,
      input: this.input,
      notice: this.notice,
      confirmPrompt: this.confirm?.prompt ?? null,
      confirmDetails: this.confirm?.details ?? null,
      confirmEffect: this.confirm?.effect ?? 'end',
      overlay: this.overlay,
      palette: this.palette,
      now: Date.now(),
    });
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
      // Everything that ends must have been on the screen: with lines cut off, yes is not taken
      const hidden = char === 'y' || char === 'Y' ? this.currentFrame().hiddenConfirmDetails : 0;
      const pending = this.confirm;
      this.confirm = null;
      if (hidden > 0) {
        this.notice = {
          text: `Nothing was ${pending.effect === 'hold' ? 'paused' : 'ended'}: ${hidden} of the processes did not fit on the screen. Make the terminal taller and ask again.`,
          level: 'warn',
        };
      } else if (char === 'y' || char === 'Y') {
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
