import fs from 'node:fs';
import path from 'node:path';

export type GuardMode = 'strict' | 'balanced' | 'yolo';

export interface GuardLimits {
  maxFilesWarn: number;
  maxFilesHardStop: number;
  maxEditsPerFilePerMinute: number;
  mcpSilenceTimeoutSec: number;
}

export interface GuardConfig {
  mode: GuardMode;
  protectedFiles: string[];
  limits: GuardLimits;
}

export const CONFIG_FILENAME = '.agentguard.json';

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  mode: 'balanced',
  protectedFiles: ['.env*', 'docker-compose*.yml', '.git/**'],
  limits: {
    maxFilesWarn: 15,
    maxFilesHardStop: 40,
    maxEditsPerFilePerMinute: 5,
    mcpSilenceTimeoutSec: 45,
  },
};

/**
 * Normalizes a mode string, supporting 'refactoring' as an alias for 'yolo'.
 */
export function normalizeMode(rawMode: unknown): GuardMode {
  if (typeof rawMode !== 'string') {
    return DEFAULT_GUARD_CONFIG.mode;
  }
  const lower = rawMode.trim().toLowerCase();
  if (lower === 'strict') return 'strict';
  if (lower === 'yolo' || lower === 'refactoring') return 'yolo';
  return 'balanced';
}

/**
 * Converts a simple glob pattern (e.g. ".env*", "docker-compose*.yml", ".git/**")
 * into a RegExp that matches normalized POSIX-style relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regexStr = '^';

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // "**/" matches zero or more directories, "**" matches anything
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 2;
        } else {
          regexStr += '.*';
          i += 1;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('+^$?.()|[]{}\\'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

/**
 * Checks whether a relative or absolute file path matches a glob pattern.
 * Patterns without slashes (like ".env*" or "docker-compose*.yml") are matched
 * against both the full relative path and the file basename.
 */
export function matchesGlobPattern(filePath: string, pattern: string, rootDir?: string): boolean {
  const relPath = (rootDir ? path.relative(rootDir, filePath) : filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const regex = globToRegExp(normalizedPattern);

  if (regex.test(relPath)) {
    return true;
  }

  // If the pattern does not specify a directory path, also test against the basename
  if (!normalizedPattern.includes('/')) {
    const base = path.posix.basename(relPath);
    if (regex.test(base)) {
      return true;
    }
  }

  return false;
}

export class GuardConfigManager {
  private rootDir: string;
  private config: GuardConfig;

  constructor(rootDir: string = process.cwd(), initialConfig?: Partial<GuardConfig>) {
    this.rootDir = path.resolve(rootDir);
    this.config = this.loadFromDiskOrDefaults(initialConfig);
  }

  public get configFilePath(): string {
    return path.join(this.rootDir, CONFIG_FILENAME);
  }

  public getConfig(): GuardConfig {
    return {
      mode: this.config.mode,
      protectedFiles: [...this.config.protectedFiles],
      limits: { ...this.config.limits },
    };
  }

  public loadFromDiskOrDefaults(overrides?: Partial<GuardConfig>): GuardConfig {
    let diskConfig: Partial<GuardConfig> = {};
    const filePath = this.configFilePath;

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        diskConfig = {
          mode: parsed.mode ? normalizeMode(parsed.mode) : undefined,
          protectedFiles: Array.isArray(parsed.protectedFiles)
            ? parsed.protectedFiles.filter((p): p is string => typeof p === 'string')
            : undefined,
          limits:
            parsed.limits && typeof parsed.limits === 'object'
              ? (parsed.limits as GuardLimits)
              : undefined,
        };
      } catch {
        // Fall back to defaults if .agentguard.json is malformed
      }
    }

    const mergedLimits: GuardLimits = {
      ...DEFAULT_GUARD_CONFIG.limits,
      ...(diskConfig.limits ?? {}),
      ...(overrides?.limits ?? {}),
    };

    const merged: GuardConfig = {
      mode: overrides?.mode
        ? normalizeMode(overrides.mode)
        : diskConfig.mode
          ? normalizeMode(diskConfig.mode)
          : DEFAULT_GUARD_CONFIG.mode,
      protectedFiles:
        overrides?.protectedFiles ??
        diskConfig.protectedFiles ??
        [...DEFAULT_GUARD_CONFIG.protectedFiles],
      limits: {
        maxFilesWarn: Number(mergedLimits.maxFilesWarn) || DEFAULT_GUARD_CONFIG.limits.maxFilesWarn,
        maxFilesHardStop:
          Number(mergedLimits.maxFilesHardStop) || DEFAULT_GUARD_CONFIG.limits.maxFilesHardStop,
        maxEditsPerFilePerMinute:
          Number(mergedLimits.maxEditsPerFilePerMinute) ||
          DEFAULT_GUARD_CONFIG.limits.maxEditsPerFilePerMinute,
        mcpSilenceTimeoutSec:
          Number(mergedLimits.mcpSilenceTimeoutSec) ||
          DEFAULT_GUARD_CONFIG.limits.mcpSilenceTimeoutSec,
      },
    };

    this.config = merged;
    return this.getConfig();
  }

  public saveConfig(customConfig?: GuardConfig): string {
    if (customConfig) {
      this.config = {
        mode: normalizeMode(customConfig.mode),
        protectedFiles: [...customConfig.protectedFiles],
        limits: { ...customConfig.limits },
      };
    }
    fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    return this.configFilePath;
  }

  public setMode(mode: GuardMode | string, persist: boolean = false): GuardConfig {
    this.config.mode = normalizeMode(mode);
    if (persist && fs.existsSync(this.configFilePath)) {
      this.saveConfig();
    }
    return this.getConfig();
  }

  public isProtectedFile(filePath: string): boolean {
    const patterns =
      this.config.mode === 'yolo'
        ? this.config.protectedFiles.filter((p) => p.includes('.env') || p.includes('.git'))
        : this.config.protectedFiles;

    return patterns.some((pattern) => matchesGlobPattern(filePath, pattern, this.rootDir));
  }

  public evaluateFileLimit(modifiedFileCount: number): 'ok' | 'warn' | 'hard-stop' {
    if (this.config.mode === 'yolo') {
      return 'ok';
    }

    if (modifiedFileCount >= this.config.limits.maxFilesHardStop) {
      return 'hard-stop';
    }

    if (modifiedFileCount >= this.config.limits.maxFilesWarn) {
      // In strict mode, unusual volume already triggers a hard stop
      return this.config.mode === 'strict' ? 'hard-stop' : 'warn';
    }

    return 'ok';
  }
}
