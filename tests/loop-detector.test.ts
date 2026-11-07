import { describe, expect, it, vi } from 'vitest';
import { LoopDetector } from '../src/core/loop-detector.js';

describe('LoopDetector (Thrashing & Circuit Breaker)', () => {
  it('counts edits within a sliding 60-second window without false positives below the limit', () => {
    const detector = new LoopDetector({ maxEditsPerFilePerMinute: 5, windowMs: 60_000 });
    const start = 1_000_000;

    for (let i = 1; i <= 5; i++) {
      const res = detector.recordEdit('src/index.ts', start + i * 1000);
      expect(res.triggered).toBe(false);
      expect(res.editCount).toBe(i);
    }

    expect(detector.getEditCount('src/index.ts', start + 5000)).toBe(5);
    expect(detector.isTripped('src/index.ts')).toBe(false);
  });

  it('triggers the circuit breaker and emits loop-detected when edits exceed maxEditsPerFilePerMinute', () => {
    const detector = new LoopDetector({ maxEditsPerFilePerMinute: 5, windowMs: 60_000 });
    const onLoop = vi.fn();
    detector.on('loop-detected', onLoop);

    const start = 2_000_000;
    for (let i = 1; i <= 5; i++) {
      detector.recordEdit('src/app.ts', start + i * 500);
    }

    const sixth = detector.recordEdit('src/app.ts', start + 3000);
    expect(sixth.triggered).toBe(true);
    expect(sixth.editCount).toBe(6);
    expect(sixth.alert).toBeDefined();
    expect(sixth.alert?.filePath).toBe('src/app.ts');
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(detector.isTripped('src/app.ts')).toBe(true);
    expect(detector.getTrippedFiles()).toContain('src/app.ts');
  });

  it('expires edits older than the 60-second sliding window', () => {
    const detector = new LoopDetector({ maxEditsPerFilePerMinute: 3, windowMs: 60_000 });
    const t0 = 5_000_000;

    detector.recordEdit('src/worker.ts', t0 + 1000);
    detector.recordEdit('src/worker.ts', t0 + 2000);
    detector.recordEdit('src/worker.ts', t0 + 3000);

    // 62 seconds after the first two edits -> only 1 edit remains in the window, plus this new one = 2
    const afterWindow = detector.recordEdit('src/worker.ts', t0 + 62_500);
    expect(afterWindow.triggered).toBe(false);
    expect(afterWindow.editCount).toBe(2);
  });

  it('tracks files independently and supports resetFile and resetAll', () => {
    const detector = new LoopDetector({ maxEditsPerFilePerMinute: 2, windowMs: 60_000 });
    const now = 10_000_000;

    detector.recordEdit('a.ts', now);
    detector.recordEdit('a.ts', now + 100);
    const thirdA = detector.recordEdit('a.ts', now + 200);
    expect(thirdA.triggered).toBe(true);

    const firstB = detector.recordEdit('b.ts', now + 200);
    expect(firstB.triggered).toBe(false);

    detector.resetFile('a.ts');
    expect(detector.isTripped('a.ts')).toBe(false);
    expect(detector.getEditCount('a.ts', now + 300)).toBe(0);

    detector.resetAll();
    expect(detector.getEditCount('b.ts', now + 300)).toBe(0);
  });
});
