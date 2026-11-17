import fs from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

/**
 * The package version, read once from package.json (the single place it is maintained).
 * Works from the sources (`src/`) and from the published bundle (`dist/`), which both sit
 * one level below the package root.
 */
export function getVersion(): string {
  if (cached) return cached;
  let version = '0.0.0-dev';
  try {
    const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const candidate of [
      path.resolve(baseDir, '../package.json'),
      path.resolve(baseDir, 'package.json'),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === 'agent-leash' && typeof pkg.version === 'string') {
        version = pkg.version;
        break;
      }
    }
  } catch {
    // Keep the fallback
  }
  cached = version;
  return version;
}
