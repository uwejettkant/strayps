// What a command line says a process is: its executable and, for an interpreter, its script.
// Agent names are matched against these exactly, never as a substring of the command line.

import type { RawProcessInfo } from './types.js';

/** Programs that run a script: the script's name is the program's real name. */
export const INTERPRETER = /^(node|nodejs|bun|deno|ruby|tsx|ts-node|python(\d+(\.\d+)*)?)$/;
const OPTIONS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const INLINE_CODE_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/** Lower-case file name of a path; a login shell shows up as "-zsh". */
export function baseName(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/^-/, '').toLowerCase();
}

function stripScriptExtension(name: string): string {
  return name.replace(/\.(m?js|cjs|ts|py)$/, '');
}

/**
 * The names a process runs as: its executable and, when that is an interpreter (node, python, ...),
 * the script or module it runs. Used to match agent names exactly instead of by substring, which
 * catches unrelated programs ("codex-mcp-server", "aider-stats.js").
 */
export function programNames(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): string[] {
  const names = new Set<string>();
  const executable = baseName(raw.name);
  if (executable) names.add(stripScriptExtension(executable));

  const args = (raw.cmd ?? '').trim().split(/\s+/).filter(Boolean);
  const first = args.length > 0 ? baseName(args[0]) : '';
  if (first) names.add(stripScriptExtension(first));

  if (INTERPRETER.test(first) || INTERPRETER.test(executable)) {
    const script = interpreterScript(args);
    if (script) names.add(script.module ? baseName(script.path) : stripScriptExtension(baseName(script.path)));
  }
  return Array.from(names);
}

/** The script (or `-m` module) an interpreter runs, from its arguments. */
export function interpreterScript(args: string[]): { path: string; module: boolean } | undefined {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (INLINE_CODE_OPTIONS.has(arg)) return undefined;
    if (arg === '-m') return args[i + 1] ? { path: args[i + 1], module: true } : undefined;
    if (OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { path: arg, module: false };
  }
  return undefined;
}

/**
 * What a process is, for the host patterns: its executable and, for an interpreter, its script.
 * Never its other arguments: agy, started by the Antigravity IDE with "antigravity" in its
 * arguments, was taken for the IDE and so for no agent at all (scenario pass, 20.11.2026).
 */
export function programIdentity(raw: Pick<RawProcessInfo, 'name' | 'cmd'>): string {
  const args = (raw.cmd ?? '').trim().split(/\s+/).filter(Boolean);
  // On macOS `name` is the full path of the executable (ps comm), spaces included
  const parts = [raw.name, args[0] ?? ''];
  if (INTERPRETER.test(baseName(args[0] ?? '')) || INTERPRETER.test(baseName(raw.name))) {
    const script = interpreterScript(args);
    if (script) parts.push(script.path);
  }
  return parts.join(' ');
}
