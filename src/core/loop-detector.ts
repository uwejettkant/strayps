import { EventEmitter } from 'node:events';

export interface LoopDetectorOptions {
  maxEditsPerFilePerMinute?: number;
  windowMs?: number;
}

export interface LoopAlert {
  filePath: string;
  editCount: number;
  limit: number;
  windowMs: number;
  timestamp: number;
}

export interface LoopCheckResult {
  triggered: boolean;
  editCount: number;
  limit: number;
  alert?: LoopAlert;
}

/**
 * Sliding-window thrashing / loop detector.
 * Tracks write events per file path in a rolling 60-second window and trips
 * the circuit breaker when edits exceed `maxEditsPerFilePerMinute`.
 */
export class LoopDetector extends EventEmitter {
  private maxEditsPerFilePerMinute: number;
  private windowMs: number;
  private editsByFile: Map<string, number[]> = new Map();
  private trippedFiles: Set<string> = new Set();

  constructor(options: LoopDetectorOptions = {}) {
    super();
    this.maxEditsPerFilePerMinute = options.maxEditsPerFilePerMinute ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
  }

  public setMaxEditsPerFilePerMinute(limit: number): void {
    if (limit > 0) {
      this.maxEditsPerFilePerMinute = limit;
    }
  }

  public getMaxEditsPerFilePerMinute(): number {
    return this.maxEditsPerFilePerMinute;
  }

  public getWindowMs(): number {
    return this.windowMs;
  }

  /**
   * Records a write event for `filePath` and evaluates whether the sliding-window
   * threshold has been exceeded.
   */
  public recordEdit(filePath: string, now: number = Date.now()): LoopCheckResult {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const cutoff = now - this.windowMs;

    const existing = this.editsByFile.get(normalizedPath) ?? [];
    const activeTimestamps = existing.filter((ts) => ts > cutoff);
    activeTimestamps.push(now);
    this.editsByFile.set(normalizedPath, activeTimestamps);

    const editCount = activeTimestamps.length;
    const triggered = editCount > this.maxEditsPerFilePerMinute;

    if (triggered) {
      this.trippedFiles.add(normalizedPath);
      const alert: LoopAlert = {
        filePath: normalizedPath,
        editCount,
        limit: this.maxEditsPerFilePerMinute,
        windowMs: this.windowMs,
        timestamp: now,
      };
      this.emit('loop-detected', alert);
      return {
        triggered: true,
        editCount,
        limit: this.maxEditsPerFilePerMinute,
        alert,
      };
    }

    return {
      triggered: false,
      editCount,
      limit: this.maxEditsPerFilePerMinute,
    };
  }

  public getEditCount(filePath: string, now: number = Date.now()): number {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const cutoff = now - this.windowMs;
    const existing = this.editsByFile.get(normalizedPath) ?? [];
    const active = existing.filter((ts) => ts > cutoff);
    if (active.length !== existing.length) {
      this.editsByFile.set(normalizedPath, active);
    }
    return active.length;
  }

  public isTripped(filePath?: string): boolean {
    if (filePath) {
      return this.trippedFiles.has(filePath.replace(/\\/g, '/'));
    }
    return this.trippedFiles.size > 0;
  }

  public getTrippedFiles(): string[] {
    return Array.from(this.trippedFiles);
  }

  public resetFile(filePath: string): void {
    const normalizedPath = filePath.replace(/\\/g, '/');
    this.editsByFile.delete(normalizedPath);
    this.trippedFiles.delete(normalizedPath);
  }

  public resetAll(): void {
    this.editsByFile.clear();
    this.trippedFiles.clear();
  }
}
