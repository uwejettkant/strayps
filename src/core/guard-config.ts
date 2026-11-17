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
 * Strict variant of `normalizeMode` for user input (CLI flags, API calls):
 * returns null instead of silently falling back to the default.
 */
export function parseMode(rawMode: unknown): GuardMode | null {
  if (typeof rawMode !== 'string') return null;
  const lower = rawMode.trim().toLowerCase();
  if (lower === 'strict' || lower === 'balanced' || lower === 'yolo') return lower;
  if (lower === 'refactoring') return 'yolo';
  return null;
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
  private warnings: string[] = [];

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

  /** Problems found in `.agentguard.json` during the last load; affected values fell back to defaults. */
  public getWarnings(): string[] {
    return [...this.warnings];
  }

  public hasConfigFile(): boolean {
    return fs.existsSync(this.configFilePath);
  }

  public loadFromDiskOrDefaults(overrides?: Partial<GuardConfig>): GuardConfig {
    let diskConfig: Partial<GuardConfig> = {};
    const filePath = this.configFilePath;
    const warnings: string[] = [];

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('top level must be a JSON object');
        }
        const record = parsed as Record<string, unknown>;

        let mode: GuardMode | undefined;
        if (record.mode !== undefined) {
          const parsedMode = parseMode(record.mode);
          if (parsedMode) {
            mode = parsedMode;
          } else {
            warnings.push(
              `mode ${JSON.stringify(record.mode)} is not one of strict | balanced | yolo, using "${DEFAULT_GUARD_CONFIG.mode}"`,
            );
          }
        }

        let protectedFiles: string[] | undefined;
        if (record.protectedFiles !== undefined) {
          if (Array.isArray(record.protectedFiles)) {
            protectedFiles = record.protectedFiles.filter(
              (p): p is string => typeof p === 'string' && p.trim().length > 0,
            );
            if (protectedFiles.length !== record.protectedFiles.length) {
              warnings.push('protectedFiles contains entries that are not glob strings, they were ignored');
            }
          } else {
            warnings.push('protectedFiles must be an array of glob strings, using the defaults');
          }
        }

        let limits: GuardLimits | undefined;
        if (record.limits !== undefined) {
          if (record.limits && typeof record.limits === 'object' && !Array.isArray(record.limits)) {
            limits = record.limits as GuardLimits;
          } else {
            warnings.push('limits must be an object, using the defaults');
          }
        }

        diskConfig = { mode, protectedFiles, limits };
      } catch (err) {
        warnings.push(
          `file is not valid JSON (${err instanceof Error ? err.message : String(err)}), using the defaults`,
        );
      }
    }

    const mergedLimits: Record<string, unknown> = {
      ...DEFAULT_GUARD_CONFIG.limits,
      ...(diskConfig.limits ?? {}),
      ...(overrides?.limits ?? {}),
    };

    const limit = (key: keyof GuardLimits): number => {
      const fallback = DEFAULT_GUARD_CONFIG.limits[key];
      const value = mergedLimits[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
        return Math.floor(value);
      }
      if (value !== undefined) {
        warnings.push(`limits.${key} must be a number >= 1 (got ${JSON.stringify(value)}), using ${fallback}`);
      }
      return fallback;
    };

    const limits: GuardLimits = {
      maxFilesWarn: limit('maxFilesWarn'),
      maxFilesHardStop: limit('maxFilesHardStop'),
      maxEditsPerFilePerMinute: limit('maxEditsPerFilePerMinute'),
      mcpSilenceTimeoutSec: limit('mcpSilenceTimeoutSec'),
    };
    if (limits.maxFilesWarn > limits.maxFilesHardStop) {
      warnings.push(
        `limits.maxFilesWarn (${limits.maxFilesWarn}) is above limits.maxFilesHardStop (${limits.maxFilesHardStop}), the warning will never show`,
      );
    }

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
      limits,
    };

    this.config = merged;
    this.warnings = warnings;
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
