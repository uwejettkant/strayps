import readline from 'node:readline';
import type { WatchdogSession } from '../core/session.js';
import type { WatchActivityEvent } from '../core/watcher.js';
import { type CommandResult, HELP_LINES, parseCommand, runCommand } from './commands.js';
import { createPalette, formatEventLine, formatStatusReport, padEnd, type Palette } from './format.js';

export interface PlainReporterOptions {
  session: WatchdogSession;
  /** Receives one line of output at a time (without trailing newline). */
  write: (line: string) => void;
  /** Line-based command input (a pipe, or a terminal in cooked mode). Omit to disable commands. */
  input?: NodeJS.ReadableStream;
  /** Only print warnings and critical events. */
  quiet?: boolean;
  color?: boolean;
  width?: number;
  onExit: (reason: 'command') => void;
}

/**
 * Line-oriented output for everything that is not an interactive terminal:
 * pipes, log files, CI, an agent's background task, or `--no-tui`.
 *
 * Prints one line per activity event and accepts the same commands as the full-screen
 * view, one per line. Reaching the end of the input does not stop the watchdog.
 */
export class PlainReporter {
  private readonly session: WatchdogSession;
  private readonly options: PlainReporterOptions;
  private readonly palette: Palette;
  private rl: readline.Interface | null = null;
  private pendingConfirm: { prompt: string; run: () => CommandResult } | null = null;
  private started = false;

  private readonly onEvent = (event: WatchActivityEvent) => {
    if (this.options.quiet && event.severity === 'info') return;
    this.options.write(formatEventLine(event, this.palette));
  };

  constructor(options: PlainReporterOptions) {
    this.options = options;
    this.session = options.session;
    this.palette = createPalette(options.color ?? false);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.session.on('event', this.onEvent);

    if (this.options.input) {
      this.rl = readline.createInterface({ input: this.options.input, terminal: false });
      this.rl.on('line', (line) => this.handleLine(line));
      // A closed or failing input must never take the watchdog down
      this.rl.on('close', () => {
        this.rl = null;
      });
      this.options.input.on('error', () => {
        this.rl?.close();
      });
    }
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.session.off('event', this.onEvent);
    this.rl?.close();
    this.rl = null;
  }

  /** Processes one line of input. Exposed for tests. */
  public handleLine(line: string): void {
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = null;
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        this.report(pending.run());
      } else {
        this.options.write('Cancelled — nothing was changed.');
      }
      return;
    }
    this.report(runCommand(this.session, parseCommand(line)));
  }

  private report(result: CommandResult): void {
    const { write } = this.options;
    if (result.exit) {
      this.options.onExit('command');
      return;
    }
    if (result.confirm) {
      this.pendingConfirm = result.confirm;
      write(this.palette.warn(`? ${result.confirm.prompt} Type "yes" to confirm:`));
      return;
    }
    if (result.showHelp) {
      write('Commands (one per line):');
      for (const [usage, description] of HELP_LINES) {
        write(`  ${padEnd(usage, 30)} ${description}`);
      }
      return;
    }
    if (result.showStatus) {
      for (const line of formatStatusReport(
        this.session.getSnapshot(),
        this.palette,
        this.options.width ?? 120,
      )) {
        write(line);
      }
      return;
    }
    if (result.message) {
      const style =
        result.level === 'error'
          ? this.palette.danger
          : result.level === 'warn'
            ? this.palette.warn
            : this.palette.ok;
      write(style(result.message));
    }
  }
}
