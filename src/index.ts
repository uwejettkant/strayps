/**
 * Programmatic API of agent-leash. Importing this module never starts the CLI.
 *
 *   import { GuardConfigManager, ProcessMonitor, WatchdogSession, listenWatchdogServer } from 'agent-leash';
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
  type ParsedConfigValue,
  parseConfigValue,
  resolveConfigKey,
  type WriteConfigValueResult,
  writeConfigValue,
} from './core/guard-config.js';
export type { ActivityEvent, ActivityEventType } from './core/events.js';
export {
  type AgentDetection,
  BUILT_IN_AGENT_NAMES,
  defaultProcessKiller,
  defaultProcessLister,
  type MonitoredProcess,
  parseCpuTime,
  parsePsOutput,
  redactSecrets,
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
  type KillConfirmation,
  type KillOptions,
  type KillPlan,
  type KillResult,
  type PauseResult,
  type StatusSnapshot,
  WatchdogSession,
  type WatchdogSessionDeps,
} from './core/session.js';
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
