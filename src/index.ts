/**
 * Programmatic API of strayps. Importing this module never starts the CLI.
 *
 *   import { ConfigManager, ProcessMonitor, MonitorSession, listenDashboardServer } from 'strayps';
 */
export {
  CONFIG_FILENAME,
  CONFIG_KEY_INFO,
  CONFIG_KEYS,
  type ConfigKey,
  type ConfigReloadResult,
  type ConfigSource,
  DEFAULT_CONFIG,
  type StraypsConfig,
  ConfigManager,
  type ConfigManagerOptions,
  type ConfigOverrides,
  type ConfigLimits,
  type ParsedConfigValue,
  parseConfigValue,
  resolveConfigKey,
  type WriteConfigValueResult,
  writeConfigValue,
} from './core/config.js';
export type { ActivityEvent, ActivityEventType } from './core/events.js';
export {
  type AgentDetection,
  BUILT_IN_AGENT_NAMES,
  defaultProcessKiller,
  defaultProcessLister,
  type MonitoredProcess,
  type PauseOutcome,
  type PauseTarget,
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
  MonitorSession,
  type MonitorSessionDeps,
} from './core/session.js';
export { CliError, createCliProgram, runCli } from './program.js';
export {
  createDashboardApp,
  type DashboardStatusSnapshot,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  type ListenServerOptions,
  listenDashboardServer,
  type RunningDashboardServer,
  type StartServerOptions,
  startDashboardServer,
  type DashboardServerDeps,
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
