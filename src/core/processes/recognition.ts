// Which processes are agents, MCP servers, or editors, desktop apps and terminals. The lists here
// decide what can be listed, paused and ended: see the skill process-classification before
// changing one.

import { baseName, INTERPRETER, interpreterScript, programIdentity, programNames } from './program-names.js';
import type { ProcessTree } from './tree.js';
import type { AgentDetection, ProcessCategory, RawProcessInfo } from './types.js';

/**
 * Agents recognized by the name of their program alone. Deliberately short, and it does not grow
 * with every new product: an agent that starts an MCP server is found through that server, and
 * users name any other agent in the `agents` setting.
 */
export const BUILT_IN_AGENT_NAMES: readonly string[] = ['claude', 'codex', 'aider'];

/** Programs that only start another program. Never the agent itself, whatever they launch. */
export const LAUNCHER_NAMES = new Set([
  // login: Terminal.app and Ghostty start the shell through it, and an MCP server run by hand in
  // such a tab made login an agent (review, 20.11.2026)
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'nohup', 'timeout', 'login',
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'corepack', 'uv', 'uvx', 'pipx',
]);

export const MCP_KEYWORDS = ['mcp', 'modelcontextprotocol'];

/** Editors and terminals by their exact program name, where no app bundle says it (Linux, tmux, sshd). */
const APP_PROGRAM_NAMES = new Set([
  'tmux',
  'sshd',
  'kitty',
  'alacritty',
  'xterm',
  'wezterm',
  'wezterm-gui',
  'ghostty',
  'konsole',
  'gnome-terminal',
  'gnome-terminal-server',
  'code',
  'code-insiders',
  'code-server',
  'codium',
  'cursor',
  'windsurf',
  'zed',
  'antigravity',
  'idea',
  'webstorm',
  'pycharm',
  'goland',
  'phpstorm',
  'rubymine',
  'clion',
  'rustrover',
  'datagrip',
  'rider',
  'fleet',
]);

/** Short macOS helper executable names when `name` is not the full bundle path. */
const APP_HELPER_NAME = /^(?:code|cursor|windsurf|antigravity(?: ide)?|claude) helper(?:\s*\([^)]+\))?$/i;

/** Remote editor server installs (VS Code / Cursor / Windsurf / Antigravity over SSH). */
const REMOTE_EDITOR_SERVER = /\/\.(?:vscode|cursor|windsurf|antigravity)-server\//i;

const APP_BUNDLE_BODY =
  '(?:Visual Studio Code(?: - Insiders)?|Code|VSCodium|Cursor|Windsurf|Kiro|Trae|Positron|Void|Zed(?: Preview)?|Antigravity(?: IDE)?|Claude|Xcode|Sublime Text|Nova|BBEdit|TextMate|MacVim|Emacs|Fleet|Android Studio|IntelliJ IDEA[^/]*|WebStorm|PyCharm[^/]*|GoLand|PhpStorm|RubyMine|CLion|RustRover|DataGrip|Rider|Terminal|iTerm2?|Warp|Ghostty|kitty|Alacritty|WezTerm|Hyper|Tabby|Wave|Rio)\\.app\\/Contents\\/(?:MacOS\\/|Frameworks\\/[^/]+\\.app\\/Contents\\/MacOS\\/|Resources\\/|Helpers\\/)';

/**
 * The app bundles of editors, IDEs, desktop apps that run agents, and terminals, by name (a closed
 * list: an app missing here is treated like any other program): their own programs (`Contents/MacOS/`,
 * helper apps under `Contents/Frameworks/`, bundled servers under `Contents/Resources/` and
 * `Contents/Helpers/`). Not `Contents/Developer/` (Xcode build tools), not `Contents/jbr/` (bundled
 * Java a build can run), and not any other app bundle: framework Python runs as
 * `Python.app/Contents/MacOS/Python`, and the Chrome or Electron app an agent drives are apps too
 * (safety review, 22.11.2026).
 */
const APP_BUNDLE_IN_NAME = new RegExp(`\\/${APP_BUNDLE_BODY}`, 'i');
// Anchored to the executable at the start of `cmd`, so a path passed as an argument
// (`vibe --open /Applications/Cursor.app/...`) never matches.
const APP_BUNDLE_IN_CMD = new RegExp(`^(?:\\/[^/\\s]+)*\\/${APP_BUNDLE_BODY}`, 'i');

/**
 * An editor, desktop app or terminal, which is never an agent and which pause never holds, decided
 * by the program file alone: a program of one of APP_BUNDLE_BODY's bundles, a remote editor server,
 * a known helper name, or one of APP_PROGRAM_NAMES. Never by a word anywhere in a path: in
 * ~/WebstormProjects an agent or tool call looked like the IDE (safety review & maintainer
 * decision, 22.11.2026).
 */
export function isAppOrTerminal(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): boolean {
  const name = raw.name ?? '';
  const cmd = (raw.cmd ?? '').trim();
  const args = cmd.split(/\s+/).filter(Boolean);
  const first = args[0] ?? '';

  // Claude Code's native binary lives under .../claude-code/.../claude.app/Contents/MacOS/claude:
  // that is the coding agent, never Claude Desktop (/Applications/Claude.app).
  if (!/\/claude-code\//i.test(name) && APP_BUNDLE_IN_NAME.test(name)) return true;
  if (!/\/claude-code\//i.test(first) && APP_BUNDLE_IN_CMD.test(cmd)) return true;

  if (APP_HELPER_NAME.test(baseName(name))) return true;
  for (const file of [name, first]) {
    if (APP_PROGRAM_NAMES.has(baseName(file).replace(/:.*$/, ''))) return true;
    if (REMOTE_EDITOR_SERVER.test(file)) return true;
  }
  if (INTERPRETER.test(baseName(first)) || INTERPRETER.test(baseName(name))) {
    const script = interpreterScript(args);
    if (script && REMOTE_EDITOR_SERVER.test(script.path)) return true;
  }
  return false;
}

export const IGNORED_SYSTEM_PATTERNS = [
  '/applications/claude.app/contents/macos/claude',
  '/applications/claude.app/contents/frameworks/',
  'claude helper',
  'contents/helpers/disclaimer',
  'cursoruiviewservice',
  'crashpad_handler',
  'gpuservice',
  'com.apple.webkit.',
  '.xpc/',
  'plugin-container.app',
];

/** Applications a process tree can hang off. First match on the nearest ancestor wins. */
export const HOST_PATTERNS: Array<[RegExp, string]> = [
  [/visual studio code|code helper|\/code\.app\/|code - insiders|vscode-server|vscodium/i, 'VS Code'],
  [/\/cursor\.app\/|cursor helper/i, 'Cursor'],
  [/windsurf/i, 'Windsurf'],
  [/antigravity/i, 'Antigravity'],
  [/\/applications\/claude\.app\//i, 'Claude Desktop'],
  [/\/zed\.app\//i, 'Zed'],
  [/jetbrains|intellij|webstorm|pycharm|goland|phpstorm|rubymine/i, 'JetBrains IDE'],
  [/(^|[\s/])tmux(\s|:|$)/i, 'tmux'],
  [/(^|[\s/])sshd(\s|:|$)/i, 'SSH session'],
  [
    /iterm|\/terminal\.app\/|\/warp\.app\/|ghostty|kitty|alacritty|wezterm|\/hyper\.app\/|konsole|gnome-terminal|xterm/i,
    'terminal',
  ],
];

/** Hosts that keep a process running without saying anyone still uses it. */
export const NON_APP_HOSTS = new Set(['detached', 'tmux', 'SSH session', 'terminal']);

/**
 * What a process is by its own command line: a coding agent (by a built-in name or a name from the
 * `agents` setting) or an MCP server. Null for everything else: that is listed only when an agent
 * started it, which the process tree decides.
 */
export function recognizeProcess(
  raw: RawProcessInfo,
  agentNames: ReadonlySet<string>,
): { category: ProcessCategory; detectedBy?: AgentDetection } | null {
  const haystack = `${raw.name} ${raw.cmd ?? ''}`.toLowerCase();

  if (IGNORED_SYSTEM_PATTERNS.some((pat) => haystack.includes(pat))) {
    return null;
  }

  const detectedBy = agentByName(raw, haystack, agentNames);
  if (detectedBy) {
    return { category: 'agent', detectedBy };
  }

  if (MCP_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return { category: 'mcp' };
  }
  return null;
}

/** An agent recognized by its program name: a built-in name, or one from the `agents` setting. */
function agentByName(raw: RawProcessInfo, haystack: string, agentNames: ReadonlySet<string>): AgentDetection | null {
  // Claude Code also runs as `node …/claude-code/cli.js` from npm or an editor extension
  if (
    haystack.includes('/claude-code/') ||
    haystack.includes('anthropic.claude-code') ||
    haystack.includes('/native-binary/claude')
  ) {
    return 'name';
  }
  const names = programNames(raw);
  if (names.some((name) => BUILT_IN_AGENT_NAMES.includes(name))) return 'name';
  if (names.some((name) => agentNames.has(name))) return 'setting';
  return null;
}

/**
 * The client that started an MCP server: its first ancestor that is not a launcher (shell, npm,
 * npx, uvx, ...) and not another MCP process. Undefined when that ancestor is an editor, a
 * desktop app or a terminal (never treated as an agent) or when the chain ends.
 */
export function findMcpClient(
  server: RawProcessInfo,
  tree: ProcessTree,
  categoryOf: (pid: number) => ProcessCategory | undefined,
): number | undefined {
  for (const cur of tree.ancestors(server.pid)) {
    const ancestor = tree.get(cur);
    if (!ancestor) return undefined;
    const text = `${ancestor.name} ${ancestor.cmd ?? ''}`;
    // Editors, desktop apps and terminals are judged by their program file alone, never by a
    // word in another process's path (~/WebstormProjects) (maintainer decision, 22.11.2026)
    if (isAppOrTerminal(ancestor)) {
      return undefined;
    }
    if (IGNORED_SYSTEM_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern))) {
      return undefined;
    }
    const launcher = programNames(ancestor).some((name) => LAUNCHER_NAMES.has(name));
    if (!launcher && categoryOf(cur) !== 'mcp') return cur;
  }
  return undefined;
}

/**
 * The application a process tree hangs off (VS Code, Claude Desktop, a terminal, ...), from the
 * nearest ancestor that is one; 'detached' for a process whose parent is PID 1.
 */
export function detectHost(raw: RawProcessInfo, tree: ProcessTree): string | undefined {
  if (!raw.ppid) return undefined;
  if (raw.ppid === 1) return 'detached';
  for (const cur of tree.ancestors(raw.pid)) {
    const ancestor = tree.get(cur);
    if (!ancestor) return undefined;
    // Only an actual editor, desktop app or terminal names a host: a script in ~/WebstormProjects
    // must not make its MCP server look attached to JetBrains IDE.
    if (isAppOrTerminal(ancestor)) {
      const identity = programIdentity(ancestor);
      for (const [pattern, label] of HOST_PATTERNS) {
        if (pattern.test(identity)) return label;
      }
    }
  }
  return undefined;
}

/**
 * True when an editor, desktop app or terminal lies between `pid` (itself included) and `agent`:
 * an editor an agent started is never held, nor what runs in it (safety review, 22.11.2026).
 */
export function hostOnTheWay(tree: ProcessTree, pid: number, agent: number | undefined): boolean {
  for (const cur of tree.selfAndAncestors(pid)) {
    if (cur === agent) return false;
    const raw = tree.get(cur);
    if (raw && isAppOrTerminal(raw)) return true;
  }
  return false;
}
