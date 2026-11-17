import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { installKillGuard } from './helpers/kill-guard.js';

// No test may reach a real process (see tests/helpers/kill-guard.ts).
installKillGuard();

// Everything a test file creates in the temp directory, including the copies that rollbacks
// keep and whatever CLI child processes write, lands in one folder that is removed afterwards.
// Nothing outside it is ever cleaned up: a real agent-leash session on this machine keeps its
// own copies in the same system temp directory.
const suiteTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-leash-suite-')));
process.env.TMPDIR = suiteTmp;
process.env.TMP = suiteTmp;
process.env.TEMP = suiteTmp;

afterAll(() => {
  fs.rmSync(suiteTmp, { recursive: true, force: true });
});
