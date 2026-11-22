# AGENTS.md — rules for coding agents working on strayps

> **One source for every agent.** This file applies to every coding agent (Claude Code, Codex, Gemini, Cursor …). `.claude/CLAUDE.md` only imports it. Rules are changed here, nowhere else.

## 0. Read first

1. This file.
2. The tests of the area you are about to change. An `it.todo` there marks behavior that is deliberately not decided yet: that decision is the maintainer's, not yours.

## 1. What this is

`strayps` is a TypeScript CLI that lists the coding agents and MCP servers running on a machine, shows which ones look left behind, and ends one process or one agent session when a person confirms it. It can also pause the agents of the repository it was started in. The same state is shown in a full-screen terminal view, in plain log output, and in a read-only local web dashboard. It does not watch files: that was cut after the tag `v0.1-full-guard`, when the tool was still called agent-leash and read `.agentguard.json`.

It is a safety tool. People install it so that less goes wrong. Every change is judged by one question first: **can this make the tool destroy something the user did not ask it to destroy?**

## 2. Non-negotiable rules

1. **Never aim the real kill or pause path at the real process table during development.** strayps terminates and pauses processes; while you develop or test it, the processes on this machine are the user's live agent sessions, including yours.
   - Tests, scenario runs and experiments always use a fake process table: `createHarness()` in `tests/helpers/harness.ts`, or `--demo`. Never send `kill` or `pause` to an instance without `--demo` to test or verify code.
   - Builds up to the tag `v0.1-full-guard` also answer `POST /api/kill/*` and `/api/pause`: never call those.
   - `strayps status` is read-only and fine against the real machine.
   - **Acting on real processes as a user tool:** only when the user explicitly asks you to end or pause real processes, never on your own initiative. List the processes from `strayps status` (including any MCP servers or children that belong to an agent's session), get the user's confirmation for the exact PIDs first, and never target your own running session.
   - Safety net, not an excuse: `tests/setup.ts` blocks `process.kill` inside the test suite.
2. **Do not run an older build on a repository someone is working in.** Builds up to the tag `v0.1-full-guard` watch files and roll one back on a confirmed `revert`. The current build reads no file but `.strayps.json`. Scenario runs that need a config file to edit go to a sandbox (`scripts/scenarios/make-sandbox.sh`).
3. **Product safety invariants.** Each one has tests. If a change breaks one of those tests, the change is wrong, not the test.
   - *Files*: the only file strayps reads in a repository is `.strayps.json`, never through a symbolic or hard link; broken JSON is never quoted, and the keys and values a warning names are untrusted text. It writes that file only on `init`, `config set` and `config unset`. No other file of a repository is read, written, restored or deleted; of `.agentguard.json`, the file of agent-leash, strayps only checks whether it is there (`lstat`, never opened), to say that it is ignored. Outside repositories it writes one thing: `footprint`'s JSON, in a private temporary directory it removes right after reading.
   - *Kill* only reaches PIDs from the monitored list: one process, or one agent with the monitored processes it started (through `agentPid`, never by status; an agent it started counts only in the same directory, never in the home directory or `/`, and anything else it started only when it works inside the agent's directory or its directory says nothing, and nothing below a listed process that works elsewhere, found by walking the whole process tree, through shells and npx that are not listed), and only those the confirmation listed, each matched by PID and `firstSeenAt`, the named process too. Nothing is ended in bulk across sessions. SIGTERM first, SIGKILL after the grace period.
   - *Pause, not stop*: the emergency brake holds (SIGSTOP) only the coding agents of the watched repository and the processes they started, their whole tree as of the last scan (listed or not: the shell around a tool call, a call of any age), and of those only what the confirmation listed, each still the same process (PID and start time on the monotonic clock, so a system-clock jump never forgets a held process; its age is read again right before SIGSTOP where `ps` can read it). Besides that, only what the confirmed agents started while the question was open, found by reading the process table again once they are held (the last scan when it cannot be read), each held only if its age fits where `ps` can read it; never a process recognized as an agent (name, `agents` setting, MCP client), an editor, desktop app or terminal (a named bundle or program, told by its program file, never by a word in a path), or anything below one of them. A recognized agent there is named as still running, to be asked about by the next pause; so is what the looks found but no longer held. A hold made while a scan waits is never forgotten by that scan. Never strayps itself, its wrappers or the agent that started it (nor what that agent runs); never a dev server the user started, an editor or another session. Pause never newly holds a process inside its SIGTERM grace period after `kill`, nor what runs below it up to its agent (held, it could keep that process from exiting cleanly); what runs below it is named in the result (the process being ended itself is not), and an agent below one is still asked about, with what it runs. What pause held before stays held when a process above it is ended: `kill` continues only what it ends. A held process stays listed until it is continued or gone, wherever it is in the tree. Nothing is terminated, no file is touched, and every held process is continued (SIGCONT) by `resume` and when strayps exits: normally, on SIGINT, SIGTERM, SIGHUP or SIGQUIT, or after an uncaught exception. SIGKILL and a fatal V8 error cannot be handled; the README says so.
   - *No verdicts on processes*: `STALE` and `FROZEN` are observations. Nothing is labeled safe to kill, and nothing is terminated in bulk because of its status, until the classification is proven on sessions still in use (it has been wrong twice).
   - *Agent recognition without a product list*: an agent is the client of an MCP server, a built-in name (`claude`, `codex`, `aider`, exact program name) or a name from the `agents` setting. Editors, desktop apps and terminals are never agents; they are recognized by their program file (`isAppOrTerminal`), never by words in a path or in another process's arguments. Adding a product name to the code needs a real case that the other two ways miss.
   - *Listed by origin, not by name*: besides agents and MCP servers, only what an agent started is listed (`child`, through the process tree, at least 5 s old), never strayps itself or the wrappers that started it. A process is never listed because its command line says `node`, `chromium` or the like.
   - *Server*: binds to loopback; answers only when addressed as this machine (Host allowlist); read-only: every request that is not GET or HEAD gets 405, no route changes anything, and the page holds no token. The event stream refuses other sites.
   - *Untrusted text*: command lines, working directories, reasons and config values come from the processes being watched. In the dashboard they go through `esc()`, in the terminal through `sanitize()`. No inline event handlers, no generated JavaScript.
   - *Asking first*: every action a person triggers that changes something (kill, pause) asks for confirmation, in both terminal front ends, whatever the process looks like. The dashboard triggers nothing.
   - *Demo mode* changes nothing: it writes no file (not even `.strayps.json`) and reaches no real process. The only file it reads is `.strayps.json`.
   - *Config reloads*: a `.strayps.json` that is not valid changes nothing in a running strayps. Every applied reload is logged as a warning, because the agent being watched can write the file too.
4. **One path for state and actions.** Front ends read `MonitorSession.getSnapshot()` and act through session methods. A new action goes into the session first, then into the terminal command (`src/ui/commands.ts`, shared by both terminal front ends), with a test at session level and one per front end. The dashboard shows state and gets no action.
5. **One source per fact.** The version lives in `package.json` (`getVersion()`). Numbers in the README (tests, bundle size) are copied from command output, never estimated.
6. **Git and publishing.** Work on `feature/<topic>` or `fix/<topic>`, Conventional Commits, one commit per finished block. No push, no tag, no `npm publish`, no GitHub release without the maintainer's explicit go-ahead.
7. **Gate before every commit:** `npm run check`. Report failures as they are; do not explain them away, and do not skip a test to get green.
8. **No secrets** in chat, repository or logs. Do not print process command lines from the real machine into documents: they can contain tokens.
9. **Report what you find.** A problem outside the current change goes to the maintainer, not into a file in this repository; once the repository is public, as a GitHub issue. A security problem never goes into a public issue: see [`SECURITY.md`](./SECURITY.md).

## 3. Commands

Node 22.12 or newer for development (the test runner needs it).

```bash
npm run check          # typecheck (sources and tests), all tests, build — the gate
npm run typecheck      # tsc for src/ and for tests/
npm test               # vitest run (unit, API, CLI end-to-end)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # tests with a coverage report
npm run build          # dashboard.css (Tailwind), then tsup: dist/index.js (library), dist/cli.js (binary), dist/index.d.ts
npm run dev            # watch this repo from the sources
npm run demo           # simulated session: fake agent, fake processes, nothing touched
```

Scenario tooling (see the `scenario-testing` skill):

```bash
scripts/scenarios/make-sandbox.sh      # throwaway git repo to watch; prints its path
scripts/scenarios/pty-drive.py         # runs a command in a real pseudo-terminal and prints the screen
scripts/scenarios/package-check.sh     # build, pack, install the tarball, import it, run the binary
```

## 4. Architecture

```text
            ConfigManager                          ProcessMonitor
            (.strayps.json, limits,                  (ps + cwd lookup every 2 s,
             extra agent names)                          classification, termination, pause)
                      \                                         /
                       +--------------  MonitorSession  -------+
                          one snapshot · one set of actions · events:
                          'event' (each log entry), 'update' (coalesced)
                         /                    |                    \
              server.ts (Hono)         ui/terminal.ts           ui/plain.ts
              GET + SSE, read-only     full-screen view         one line per event,
              ui/public/index.html     + command line           commands from stdin
```

| Module | Responsibility |
| :--- | :--- |
| `src/core/config.ts` | `.strayps.json`: the limits (`mcpSilenceTimeoutSec`, `staleSessionHours`) and extra agent names, defaults, validation with warnings. Keys of older versions (`mode`, `protectedFiles`, file limits) are ignored with a notice. `reload` applies a changed file only when all of it is valid; `writeConfigValue` changes one key for `strayps config`; `getSources` says where each value comes from. |
| `src/core/events.ts` | `ActivityEventType` and `ActivityEvent`: what can appear in the activity log. |
| `src/core/process-monitor.ts` | `ProcessMonitor`, the one owner of process state. `performScan` in phases: what is listed (agents and MCP servers by their own command line, the clients of MCP servers, what agents started: `child`, through the tree), working directories and memory (`memoryReader`: macOS `footprint` every 15 s with the real lister only, RSS marked `rss` otherwise), one observation per listed process (`measure`: CPU time, new children; `inWatchedRepo`, `agentPid`, `pauseTarget`, `host`), what is gone. Graceful termination, pause and resume. |
| `src/core/processes/` | The stateless parts the monitor uses. `types.ts` (the shared records), `tree.ts` (`ProcessTree`: every walk up or down the tree, `MAX_TREE_DEPTH`), `recognition.ts` (agent recognition: `recognizeProcess`, `findMcpClient`; the launcher, editor, app and terminal lists, `isAppOrTerminal`, `detectHost`), `classify.ts` (`classifyStatus`: `ACTIVE`, `IDLE`, `STANDBY`, `STALE`, `FROZEN` and the reason), `program-names.ts`, `command-line.ts` (secret redaction, the readable command line), `cwd.ts` (`/proc` on Linux, `lsof` elsewhere), `memory.ts`, `system.ts` (`ps` and the only real signals). |
| `src/core/session.ts` | The only place where config and monitor meet. Snapshot, actions (`getKillPlan`, `killProcess`, `getPauseTargets`, `pause`, `resume`), event log, coalesced updates, live config (`watchConfigFile` polls `.strayps.json`, `reloadConfig` applies it to the monitor). |
| `src/server.ts` | Read-only Hono app: request guards (Host; every method but GET and HEAD gets 405), `/api/status`, SSE, page delivery with nonce and CSP, `listenDashboardServer` (loopback, port fallback). |
| `src/ui/commands.ts` | Command language shared by both terminal front ends: parse, run (destructive commands return a confirmation step), tab completion. |
| `src/ui/terminal.ts` | `renderFrame` (pure: state in, lines out) and `TerminalUI` (raw-mode input, alternate screen, restore on exit). |
| `src/ui/plain.ts` | Line output for pipes, logs, background jobs and `--no-tui`. |
| `src/ui/format.ts` | `sanitize`, truncation, colors (honors `NO_COLOR`), shared tables. |
| `src/ui/public/index.html` | The dashboard page. Its styles are `dashboard.css` next to it, generated by `npm run build:css` (part of `npm run build`) from the Tailwind classes in the page and committed; the page loads nothing from another host. After changing classes, run the build and commit both files. A view only: no buttons, no dialogs, no requests but GET. Placeholders `__STRAYPS_VERSION__`, `__STRAYPS_NONCE__` are filled by the server. |
| `src/program.ts` | The CLI: commands (`watch`, `status`, `init`, `config show/set/unset`), argument validation, wiring, choice between full-screen and plain output, shutdown (continues paused processes). |
| `src/cli.ts` / `src/index.ts` | Binary entry / library entry. Importing the library never starts anything. |

How the CLI picks its output: full-screen view when stdin and stdout are a terminal and the process is in the foreground; plain lines otherwise (pipe, file, background job, `--no-tui`). In plain mode commands are read from stdin; the end of stdin does not stop strayps.

## 5. Conventions

- TypeScript strict, ES module syntax, relative imports with the `.js` suffix, named exports only.
- English for code, comments, commit messages and documentation in this repository.
- Comments say why, not what. A safety rule in code names the failure it prevents.
- A new event type is added to `ActivityEventType` in `src/core/events.ts`; front ends color by `severity`, so they need no change.
- A new setting goes into `ConfigLimits` (or `StraypsConfig`), `CONFIG_KEY_INFO` and the settings table in the README in the same change; `strayps config` lists it from there.
- No new runtime dependency without a reason that fits in one sentence. Runtime dependencies today: `commander`, `hono`, `@hono/node-server`, `ps-list`.
- User-facing wording is plain and literal: say what will happen to which process.

## 6. Testing

- Tests live in `tests/*.test.ts` (Vitest). `tests/helpers/harness.ts` builds config, monitor and session with a fake process table and a fake killer; `tests/helpers/processes.ts` builds a bare monitor on a fake table for the process tests (`process-classification`, `-kill`, `-pause`, `-bookkeeping`); `tests/helpers/kill-guard.ts` is the suite-wide block on real kills.
- Config tests use real temporary directories (`makeTmpDir`). Time-dependent code uses fake timers or an injected `now`.
- `tests/cli.e2e.test.ts` starts the real CLI in a child process. Anything that could reach processes runs with `--demo`.
- The full-screen view is tested twice: `renderFrame` and `TerminalUI` against a fake terminal in Vitest, and by hand in a real pseudo-terminal with `scripts/scenarios/pty-drive.py`.
- The dashboard script is executed against a stand-in DOM (`tests/dashboard-page.test.ts`) to prove that hostile command lines and messages stay text and that the page sends nothing but reads.
- A test name states the behavior. `it.todo` marks behavior that is not decided yet; do not turn one into a passing test by choosing the behavior yourself.
- For a safety fix, show once that the new test fails on the old code.
- Platform truth: verified on macOS. Linux paths exist (`/proc` lookup) but are unverified; Windows is not supported. Do not claim more in user-facing text.

## 7. Skills and subagents

| What | Where | Use it when |
| :--- | :--- | :--- |
| Skill `scenario-testing` | `.agents/skills/scenario-testing/` | A change needs to be seen working end to end: terminal view, dashboard, package. |
| Skill `process-classification` | `.agents/skills/process-classification/` | You touch how agents are recognized, what counts as stale, frozen or standby, or what pause holds. |
| Skill `release-check` | `.agents/skills/release-check/` | The maintainer asks for a release, or to judge release readiness. |
| Subagent `scenario-tester` | `.claude/agents/scenario-tester.md` | The scenario pass should run in its own context and come back as a findings list. |
| Subagent `safety-reviewer` | `.claude/agents/safety-reviewer.md` | A diff touches termination, pause, the server, the config file or anything rendered from watched data. |

Skills are created and edited only in `.agents/skills/`, with `name` and `description` as their only frontmatter. `.claude/skills/` holds symlinks to them. `.agents/` contains no `AGENTS.md`.

## 8. Documentation

- [`README.md`](./README.md): what users read. Claims there must be true today.
- [`SECURITY.md`](./SECURITY.md): how to report a vulnerability privately.
