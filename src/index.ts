/**
 * Programmatic API of agent-leash. Importing this module never starts the CLI.
 *
 *   import { GuardConfigManager, RepoWatcher, ProcessMonitor, WatchdogSession,
 *            listenWatchdogServer } from 'agent-leash';
 */
export {
  CONFIG_FILENAME,
  CONFIG_KEY_INFO,
  CONFIG_KEYS,
  type ConfigKey,
  type ConfigReloadResult,
  type ConfigSource,
  DEFAULT_GUARD_CONFIG,
  type GuardConfig,
  GuardConfigManager,
  type GuardConfigManagerOptions,
  type GuardConfigOverrides,
  type GuardLimits,
  type GuardMode,
  globToRegExp,
  matchesGlobPattern,
  normalizeMode,
  type ParsedConfigValue,
  parseConfigValue,
  parseMode,
  type PersistModeResult,
  resolveConfigKey,
  type WriteConfigValueResult,
  writeConfigValue,
} from './core/guard-config.js';
export {
  type LoopAlert,
  type LoopCheckResult,
  LoopDetector,
  type LoopDetectorOptions,
} from './core/loop-detector.js';
export {
  type AgentDetection,
  BUILT_IN_AGENT_NAMES,
  defaultProcessKiller,
  defaultProcessLister,
  type MonitoredProcess,
  parseElapsedTime,
  type ProcessCategory,
  type ProcessHealthStatus,
  type ProcessKilledEvent,
  ProcessMonitor,
  type ProcessMonitorOptions,
  programNames,
  type RawProcessInfo,
} from './core/process-monitor.js';
export {
  type KillResult,
  type ModeResult,
  type PanicResult,
  type StatusSnapshot,
  WatchdogSession,
  type WatchdogSessionDeps,
} from './core/session.js';
export {
  type CheckpointInfo,
  type PanicRollbackResult,
  RepoWatcher,
  type RepoWatcherOptions,
  type WatchActivityEvent,
  type WatchEventType,
} from './core/watcher.js';
export { CliError, createCliProgram, runCli } from './program.js';
export {
  createWatchdogApp,
  type DashboardStatusSnapshot,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  type ListenServerOptions,
  listenWatchdogServer,
  type RunningWatchdogServer,
  type StartServerOptions,
  startWatchdogServer,
  TOKEN_HEADER,
  type WatchdogServerDeps,
} from './server.js';
export { PlainReporter, type PlainReporterOptions } from './ui/plain.js';
export {
  type Frame,
  type FrameView,
  renderFrame,
  TerminalUI,
  type TerminalUIOptions,
} from './ui/terminal.js';
export { getVersion } from './version.js';
