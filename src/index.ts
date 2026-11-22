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
export { ProcessMonitor, type ProcessMonitorOptions } from './core/process-monitor.js';
export { redactSecrets } from './core/processes/command-line.js';
export { programNames } from './core/processes/program-names.js';
export { BUILT_IN_AGENT_NAMES } from './core/processes/recognition.js';
export {
  defaultProcessKiller,
  defaultProcessLister,
  parseCpuTime,
  parseElapsedTime,
  parsePsOutput,
} from './core/processes/system.js';
export type {
  AgentDetection,
  MonitoredProcess,
  PauseOutcome,
  PauseTarget,
  ProcessCategory,
  ProcessHealthStatus,
  ProcessKilledEvent,
  RawProcessInfo,
} from './core/processes/types.js';
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
