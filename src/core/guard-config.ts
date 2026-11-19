import fs from 'node:fs';
import path from 'node:path';

export interface GuardLimits {
  /** Files modified in this session before a warning. */
  maxFilesWarn: number;
  /** Files modified in this session before the hard-stop alarm. */
  maxFilesHardStop: number;
  /** Edits to one file within 60 seconds before the circuit breaker raises an alarm. */
  maxEditsPerFilePerMinute: number;
  /** Seconds without CPU or file activity before a process counts as frozen. */
  mcpSilenceTimeoutSec: number;
  /** Hours after which a session in another repository counts as stale. */
  staleSessionHours: number;
}

/**
 * What agent-leash watches for. There are no modes: it always watches exactly by these settings,
 * so no switch can quietly turn off a protection the user configured.
 */
export interface GuardConfig {
  protectedFiles: string[];
  /** Program names to treat as coding agents, on top of the built-in names and MCP clients. */
  agents: string[];
  limits: GuardLimits;
}

/** Values that take precedence over `.agentguard.json`, e.g. from the programmatic API. */
export interface GuardConfigOverrides {
  protectedFiles?: string[];
  agents?: string[];
  limits?: Partial<GuardLimits>;
}

export interface GuardConfigManagerOptions {
  /** Never write `.agentguard.json` (used by `--demo`). Reading and reloading still work. */
  readOnly?: boolean;
}

export const CONFIG_FILENAME = '.agentguard.json';

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  protectedFiles: ['.env*', 'docker-compose*.yml', '.git/**'],
  agents: [],
  limits: {
    maxFilesWarn: 15,
    maxFilesHardStop: 40,
    maxEditsPerFilePerMinute: 5,
    mcpSilenceTimeoutSec: 45,
    staleSessionHours: 6,
  },
};

const LIMIT_KEYS: ReadonlyArray<keyof GuardLimits> = [
  'maxFilesWarn',
  'maxFilesHardStop',
  'maxEditsPerFilePerMinute',
  'mcpSilenceTimeoutSec',
  'staleSessionHours',
];

export type ConfigKey = 'protectedFiles' | 'agents' | `limits.${keyof GuardLimits}`;

export const CONFIG_KEYS: ConfigKey[] = [
  ...LIMIT_KEYS.map((key) => `limits.${key}` as ConfigKey),
  'protectedFiles',
  'agents',
];

/** A program name as `ps` shows it: no path, no spaces. */
function isProgramName(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s/\\]+$/.test(value.trim());
}

/** What each setting does. Shown by `agent-leash config`; the README table mirrors it. */
export const CONFIG_KEY_INFO: Record<ConfigKey, string> = {
  'limits.maxFilesWarn': 'files modified in this session before a warning',
  'limits.maxFilesHardStop': 'files modified in this session before the hard-stop alarm',
  'limits.maxEditsPerFilePerMinute': 'edits to one file within 60 s before the circuit breaker raises an alarm',
  'limits.mcpSilenceTimeoutSec': 'seconds without CPU or file activity before a process counts as frozen',
  'limits.staleSessionHours': 'hours after which a session in another repository counts as stale',
  protectedFiles: 'globs; a change to a match raises an alarm (revert restores it); .env* contents are never read',
  agents:
    'more program names to treat as coding agents (exact name, e.g. vibe); agents that start MCP servers are found without this',
};

/** Where an effective value comes from. */
export type ConfigSource = 'default' | 'file' | 'override';

export interface ConfigReloadResult {
  /** True if the file was valid and its values are now in effect. */
  applied: boolean;
  /** Settings whose effective value changed, e.g. "limits.maxFilesWarn 15 → 20". */
  changes: string[];
  /** Problems in the file. When `applied` is false, they are the reason. */
  warnings: string[];
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
  // A relative path is relative to the repository, not to the directory agent-leash was started in
  const relPath = (
    rootDir
      ? path.relative(rootDir, path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath))
      : filePath
  )
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

// --- Reading the file -------------------------------------------------------------------------

interface ValueError {
  /** What is wrong, without saying what happens instead. */
  message: string;
  /** What the startup load does instead, appended to the message. */
  startupSuffix: string;
}

interface FileRead {
  state: 'missing' | 'ok' | 'invalid';
  invalidReason?: string;
  protectedFiles?: string[];
  agents?: string[];
  limits: Partial<GuardLimits>;
  /** Invalid values; they are left out of `protectedFiles` / `agents` / `limits`. */
  errors: ValueError[];
  /** Things that are valid but probably not what was meant (unknown keys). */
  notices: string[];
}

function validLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readConfigFile(filePath: string): FileRead {
  const result: FileRead = { state: 'missing', limits: {}, errors: [], notices: [] };
  if (!fs.existsSync(filePath)) return result;

  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('top level must be a JSON object');
    }
    record = parsed;
  } catch (err) {
    result.state = 'invalid';
    result.invalidReason = `file is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
    return result;
  }
  result.state = 'ok';

  for (const key of Object.keys(record)) {
    if (key === 'mode') {
      // The modes were removed: an old file still loads, the key just has no effect
      result.notices.push('"mode" no longer exists and is ignored: agent-leash always watches by the settings in this file');
      continue;
    }
    if (key !== 'protectedFiles' && key !== 'agents' && key !== 'limits') {
      result.notices.push(`"${key}" is not a known setting and is ignored`);
    }
  }

  if (record.agents !== undefined) {
    if (Array.isArray(record.agents)) {
      const names = record.agents.filter(isProgramName).map((name) => name.trim());
      if (names.length !== record.agents.length) {
        result.errors.push({
          message: 'agents contains entries that are not program names (a name like "vibe", no path, no spaces)',
          startupSuffix: ', they were ignored',
        });
      }
      result.agents = names;
    } else {
      result.errors.push({
        message: 'agents must be an array of program names',
        startupSuffix: ', using none',
      });
    }
  }

  if (record.protectedFiles !== undefined) {
    if (Array.isArray(record.protectedFiles)) {
      const globs = record.protectedFiles.filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0,
      );
      if (globs.length !== record.protectedFiles.length) {
        result.errors.push({
          message: 'protectedFiles contains entries that are not glob strings',
          startupSuffix: ', they were ignored',
        });
      }
      result.protectedFiles = globs;
    } else {
      result.errors.push({
        message: 'protectedFiles must be an array of glob strings',
        startupSuffix: ', using the defaults',
      });
    }
  }

  if (record.limits !== undefined) {
    if (isRecord(record.limits)) {
      for (const [key, value] of Object.entries(record.limits)) {
        if (!(LIMIT_KEYS as ReadonlyArray<string>).includes(key)) {
          result.notices.push(`limits.${key} is not a known setting and is ignored`);
          continue;
        }
        const limitKey = key as keyof GuardLimits;
        const valid = validLimit(value);
        if (valid === null) {
          result.errors.push({
            message: `limits.${key} must be a number >= 1 (got ${JSON.stringify(value)})`,
            startupSuffix: `, using ${DEFAULT_GUARD_CONFIG.limits[limitKey]}`,
          });
        } else {
          result.limits[limitKey] = valid;
        }
      }
    } else {
      result.errors.push({ message: 'limits must be an object', startupSuffix: ', using the defaults' });
    }
  }

  return result;
}

function describeChanges(before: GuardConfig, after: GuardConfig): string[] {
  const changes: string[] = [];
  for (const key of LIMIT_KEYS) {
    if (before.limits[key] !== after.limits[key]) {
      changes.push(`limits.${key} ${before.limits[key]} → ${after.limits[key]}`);
    }
  }
  // Named as a difference, losses first: a long list cut off by the terminal width would hide
  // exactly the part someone has to notice, a file that is no longer protected
  const removed = before.protectedFiles.filter((glob) => !after.protectedFiles.includes(glob));
  const added = after.protectedFiles.filter((glob) => !before.protectedFiles.includes(glob));
  if (removed.length > 0) changes.push(`no longer protected: ${removed.join(', ')}`);
  if (added.length > 0) changes.push(`now protected: ${added.join(', ')}`);
  const agentsRemoved = before.agents.filter((name) => !after.agents.includes(name));
  const agentsAdded = after.agents.filter((name) => !before.agents.includes(name));
  if (agentsRemoved.length > 0) changes.push(`no longer treated as agents: ${agentsRemoved.join(', ')}`);
  if (agentsAdded.length > 0) changes.push(`now treated as agents: ${agentsAdded.join(', ')}`);
  return changes;
}

// --- The manager ------------------------------------------------------------------------------

export class GuardConfigManager {
  private rootDir: string;
  private config: GuardConfig;
  private warnings: string[] = [];
  private overrides: GuardConfigOverrides;
  private readOnly: boolean;
  private sources: Record<ConfigKey, ConfigSource>;

  constructor(
    rootDir: string = process.cwd(),
    initialConfig?: GuardConfigOverrides,
    options: GuardConfigManagerOptions = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.overrides = initialConfig ?? {};
    this.readOnly = options.readOnly ?? false;
    this.sources = Object.fromEntries(CONFIG_KEYS.map((key) => [key, 'default'])) as Record<
      ConfigKey,
      ConfigSource
    >;
    this.config = this.loadFromDiskOrDefaults();
  }

  public get configFilePath(): string {
    return path.join(this.rootDir, CONFIG_FILENAME);
  }

  public getConfig(): GuardConfig {
    return {
      protectedFiles: [...this.config.protectedFiles],
      agents: [...this.config.agents],
      limits: { ...this.config.limits },
    };
  }

  /** Problems found in `.agentguard.json` during the last load or reload. */
  public getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Where each effective value comes from: built-in default, the file, or an override. */
  public getSources(): Record<ConfigKey, ConfigSource> {
    return { ...this.sources };
  }

  public hasConfigFile(): boolean {
    return fs.existsSync(this.configFilePath);
  }

  public isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Loads the file as at startup: invalid values fall back to the defaults, with a warning each.
   * Passing `overrides` replaces the overrides given to the constructor.
   */
  public loadFromDiskOrDefaults(overrides?: GuardConfigOverrides): GuardConfig {
    if (overrides) this.overrides = overrides;
    const file = readConfigFile(this.configFilePath);
    const warnings: string[] = [];
    if (file.state === 'invalid') {
      warnings.push(`${file.invalidReason}, using the defaults`);
    }
    for (const error of file.errors) {
      warnings.push(`${error.message}${error.startupSuffix}`);
    }
    warnings.push(...file.notices);

    const merged = this.merge(file);
    this.config = merged.config;
    this.warnings = [...warnings, ...merged.notices];
    return this.getConfig();
  }

  /**
   * Re-reads the file while the watchdog runs. A file with invalid content is not applied at all:
   * the previous settings stay in effect and the result says why.
   */
  public reload(): ConfigReloadResult {
    const file = readConfigFile(this.configFilePath);
    if (file.state === 'invalid') {
      return { applied: false, changes: [], warnings: [file.invalidReason ?? 'file is not valid JSON'] };
    }
    if (file.errors.length > 0) {
      return { applied: false, changes: [], warnings: [...file.errors.map((e) => e.message), ...file.notices] };
    }

    const before = this.getConfig();
    const merged = this.merge(file);
    this.config = merged.config;
    this.warnings = [...file.notices, ...merged.notices];
    return { applied: true, changes: describeChanges(before, this.config), warnings: this.getWarnings() };
  }

  /** Writes the complete effective configuration (used by `agent-leash init`). */
  public saveConfig(customConfig?: GuardConfig): string {
    if (this.readOnly) {
      throw new Error(`${CONFIG_FILENAME} is read-only in this session`);
    }
    if (customConfig) {
      this.config = {
        protectedFiles: [...customConfig.protectedFiles],
        agents: [...(customConfig.agents ?? [])],
        limits: { ...customConfig.limits },
      };
    }
    fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    for (const key of CONFIG_KEYS) this.sources[key] = 'file';
    return this.configFilePath;
  }

  public isProtectedFile(filePath: string): boolean {
    return this.config.protectedFiles.some((pattern) => matchesGlobPattern(filePath, pattern, this.rootDir));
  }

  public evaluateFileLimit(modifiedFileCount: number): 'ok' | 'warn' | 'hard-stop' {
    if (modifiedFileCount >= this.config.limits.maxFilesHardStop) {
      return 'hard-stop';
    }

    if (modifiedFileCount >= this.config.limits.maxFilesWarn) {
      return 'warn';
    }

    return 'ok';
  }

  private merge(file: FileRead): { config: GuardConfig; notices: string[] } {
    const notices: string[] = [];
    const sources = { ...this.sources };

    const limits = { ...DEFAULT_GUARD_CONFIG.limits };
    for (const key of LIMIT_KEYS) {
      const overrideValue = this.overrides.limits?.[key];
      const validOverride = overrideValue === undefined ? null : validLimit(overrideValue);
      if (overrideValue !== undefined && validOverride === null) {
        notices.push(`limits.${key} override must be a number >= 1 (got ${JSON.stringify(overrideValue)}), ignored`);
      }
      if (validOverride !== null) {
        limits[key] = validOverride;
        sources[`limits.${key}`] = 'override';
      } else if (file.limits[key] !== undefined) {
        limits[key] = file.limits[key]!;
        sources[`limits.${key}`] = 'file';
      } else {
        sources[`limits.${key}`] = 'default';
      }
    }
    if (limits.maxFilesWarn > limits.maxFilesHardStop) {
      notices.push(
        `limits.maxFilesWarn (${limits.maxFilesWarn}) is above limits.maxFilesHardStop (${limits.maxFilesHardStop}), the warning will never show`,
      );
    }

    let protectedFiles: string[];
    if (this.overrides.protectedFiles) {
      protectedFiles = [...this.overrides.protectedFiles];
      sources.protectedFiles = 'override';
    } else if (file.protectedFiles) {
      protectedFiles = [...file.protectedFiles];
      sources.protectedFiles = 'file';
    } else {
      protectedFiles = [...DEFAULT_GUARD_CONFIG.protectedFiles];
      sources.protectedFiles = 'default';
    }

    let agents: string[];
    if (this.overrides.agents) {
      agents = [...this.overrides.agents];
      sources.agents = 'override';
    } else if (file.agents) {
      agents = [...file.agents];
      sources.agents = 'file';
    } else {
      agents = [...DEFAULT_GUARD_CONFIG.agents];
      sources.agents = 'default';
    }

    this.sources = sources;
    return { config: { protectedFiles, agents, limits }, notices };
  }
}

// --- Changing single values (agent-leash config set / unset) ----------------------------------

/** Accepts `limits.maxFilesWarn`, `maxFilesWarn` or any capitalization of either. */
export function resolveConfigKey(input: string): ConfigKey | null {
  const wanted = input.trim().toLowerCase();
  for (const key of CONFIG_KEYS) {
    if (key.toLowerCase() === wanted) return key;
    if (key.startsWith('limits.') && key.slice('limits.'.length).toLowerCase() === wanted) return key;
  }
  return null;
}

export type ParsedConfigValue =
  | { ok: true; value: number | string[] }
  | { ok: false; error: string };

/** Validates a value typed on the command line for one setting. */
export function parseConfigValue(key: ConfigKey, raw: string): ParsedConfigValue {
  const text = raw.trim();
  if (key === 'protectedFiles') {
    const globs = text
      .split(',')
      .map((glob) => glob.trim())
      .filter(Boolean);
    return globs.length > 0
      ? { ok: true, value: globs }
      : { ok: false, error: 'expected one or more globs, separated by commas' };
  }
  if (key === 'agents') {
    const names = text
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) {
      return { ok: false, error: 'expected one or more program names, separated by commas' };
    }
    const invalid = names.find((name) => !isProgramName(name));
    return invalid
      ? { ok: false, error: `"${invalid}" is not a program name (no path, no spaces), e.g. vibe` }
      : { ok: true, value: names };
  }
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    return { ok: false, error: `${key} must be a whole number >= 1 (got "${raw}")` };
  }
  return { ok: true, value: Number(text) };
}

export interface WriteConfigValueResult {
  filePath: string;
  /** The file did not exist before. */
  created: boolean;
  /** The value that was in the file before, if any. */
  previous: unknown;
  /** False when there was nothing to change (unset of a key that is not in the file). */
  changed: boolean;
}

/**
 * Sets one key in `.agentguard.json` (or removes it when `value` is undefined), keeping every
 * other key exactly as it is. Refuses to touch a file that is not valid JSON.
 */
export function writeConfigValue(
  rootDir: string,
  key: ConfigKey,
  value: number | string[] | undefined,
): WriteConfigValueResult {
  const filePath = path.join(path.resolve(rootDir), CONFIG_FILENAME);
  const exists = fs.existsSync(filePath);
  let record: Record<string, unknown> = {};
  if (exists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    } catch (err) {
      throw new Error(
        `${filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix it first; nothing was changed.`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`${filePath} must contain a JSON object. Fix it first; nothing was changed.`);
    }
    record = parsed;
  }

  let previous: unknown;
  if (key.startsWith('limits.')) {
    const limitKey = key.slice('limits.'.length);
    const limits = isRecord(record.limits) ? { ...record.limits } : {};
    previous = limits[limitKey];
    if (value === undefined) {
      delete limits[limitKey];
    } else {
      limits[limitKey] = value;
    }
    if (Object.keys(limits).length > 0) {
      record.limits = limits;
    } else {
      delete record.limits;
    }
  } else {
    previous = record[key];
    if (value === undefined) {
      delete record[key];
    } else {
      record[key] = value;
    }
  }

  const changed = value !== undefined || previous !== undefined;
  if (!changed) {
    return { filePath, created: false, previous, changed: false };
  }
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return { filePath, created: !exists, previous, changed: true };
}
