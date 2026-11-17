# AGENTS.md — rules for coding agents working on agent-leash

> **One source for every agent.** This file applies to every coding agent (Claude Code, Codex, Gemini, Cursor …). `.claude/CLAUDE.md` only imports it. Rules are changed here, nowhere else.

## 0. Read first

1. This file.
2. The tests of the area you are about to change. An `it.todo` there marks behavior that is deliberately not decided yet: that decision is the maintainer's, not yours.

## 1. What this is

`agent-leash` is a TypeScript CLI that watches a repository while autonomous coding agents work in it. It reports and reverts edit loops and edits to protected files, and it lists agent and MCP processes so that forgotten ones can be terminated. The same state is shown in a full-screen terminal view, in plain log output, and in a local web dashboard.

It is a safety tool. People install it so that less goes wrong. Every change is judged by one question first: **can this make the tool destroy something the user did not ask it to destroy?**

## 2. Non-negotiable rules

1. **Never aim the real kill path at the real process table.** agent-leash terminates processes; while you develop it, the processes on this machine are the user's live agent sessions, including yours.
   - Tests and experiments use a fake process table: `createHarness()` in `tests/helpers/harness.ts`, or `--demo`.
   - Never send `kill` or `panic` (terminal) or `POST /api/kill/*`, `/api/panic` to an instance that runs without `--demo`.
   - `agent-leash status` is read-only and fine against the real machine.
   - Safety nets, not excuses: `tests/setup.ts` blocks `process.kill` inside the test suite; `scripts/agents/leash-guard.mjs` (Claude Code hook) asks the user before a kill or panic endpoint is called.
2. **Never run the watchdog on a repository you are editing with auto-rollback on.** It reverts your files when the circuit breaker trips. `npm run dev` therefore uses `--no-auto-rollback`. Scenario runs go to a sandbox (`scripts/scenarios/make-sandbox.sh`).
3. **Product safety invariants.** Each one has tests. If a change breaks one of those tests, the change is wrong, not the test.
   - *Rollback* only touches paths inside the watched repository, never ignored paths (`.git`, `node_modules`, …), never `.env*`. It deletes a file only if that file was created during the session, and it keeps the version it replaces.
   - *`.env*` contents are never read* — not into the snapshot, not for comparison, not for backup.
   - *Kill* only reaches PIDs from the monitored list, one PID at a time. SIGTERM first, SIGKILL after the grace period. Panic is the exception: SIGKILL at once, but only for the coding agents of the watched repository and the processes they started; never a dev server, an editor or another session.
   - *No verdicts on processes*: `STALE` and `FROZEN` are observations. Nothing is labeled safe to kill, and nothing is terminated in bulk because of its status, until the classification is proven on sessions still in use (it has been wrong twice).
   - *Agent recognition without a product list*: an agent is the client of an MCP server, a built-in name (`claude`, `codex`, `aider`, exact program name) or a name from the `agents` setting. Editors, desktop apps and terminals are never agents. Adding a product name to the code needs a real case that the other two ways miss.
   - *Server*: binds to loopback; answers only when addressed as this machine (Host allowlist); every state-changing request needs the dashboard token and the same origin.
   - *Untrusted text*: file names, command lines, working directories and reasons come from the processes being watched. In the dashboard they go through `esc()`, in the terminal through `sanitize()`. No inline event handlers, no generated JavaScript.
   - *Asking first*: every destructive action a person triggers (revert, kill, panic) asks for confirmation, in every front end, whatever the file or process looks like. Automatic rollbacks are the product's job and are announced, not asked.
   - *Demo mode* changes nothing: it writes no file (not even `.agentguard.json`) and reaches no real process. The only file it reads is `.agentguard.json`.
   - *Config reloads*: an `.agentguard.json` that is not valid changes nothing in a running watchdog. Every applied reload is logged as a warning, because the agent being watched can write the file too. Edits to the file are never treated as agent edits and never reverted.
4. **One path for state and actions.** Front ends read `WatchdogSession.getSnapshot()` and act through session methods. A new action goes into the session first, then into the API route, the terminal command and the dashboard, with a test at session level and one per front end.
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
npm run build          # tsup: dist/index.js (library), dist/cli.js (binary), dist/index.d.ts
npm run dev            # watch this repo, observe only (--no-auto-rollback)
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
            GuardConfigManager          RepoWatcher                 ProcessMonitor
            (.agentguard.json,          (chokidar, checkpoint,      (ps + cwd lookup every 2 s,
             modes, globs)               rollback, kept copies)      classification, termination)
                      \                       |                         /
                       +--------------  WatchdogSession  --------------+
                          one snapshot · one set of actions · events:
                          'event' (each log entry), 'update' (coalesced)
                         /                    |                    \
              server.ts (Hono)         ui/terminal.ts           ui/plain.ts
              REST + SSE + page        full-screen view         one line per event,
              ui/public/index.html     + command line           commands from stdin
```

| Module | Responsibility |
| :--- | :--- |
| `src/core/guard-config.ts` | `.agentguard.json`, defaults, validation with warnings, glob matching, mode policies (`strict`, `balanced`, `yolo`). `reload` applies a changed file only when all of it is valid; `switchMode` writes only the `mode` key; `writeConfigValue` changes one key for `agent-leash config`; `getSources` says where each value comes from. `parseMode` is strict (user input), `normalizeMode` lenient. |
| `src/core/loop-detector.ts` | Sliding 60-second window per file; trips when `maxEditsPerFilePerMinute` is exceeded. |
| `src/core/watcher.ts` | File events, session checkpoint (memory snapshot plus a git ref for large tracked files), rollback and panic rollback, kept copies of replaced versions, recognition of its own writes by content, `dryRun` for the demo. |
| `src/core/process-monitor.ts` | Process list, working directories (`/proc` on Linux, `lsof` elsewhere), agent recognition (`programNames` for exact names, `findMcpClient` for agents of any name), classification (`ACTIVE`, `IDLE`, `STANDBY`, `STALE`, `FROZEN`), `inWatchedRepo` and `agentPid` via the process tree, `panicTarget`, `host` (what a session is attached to), graceful termination. |
| `src/core/session.ts` | The only place where the three meet. Snapshot, actions (`setMode`, `rollbackFile`, `killProcess`, `getPanicTargets`, `panic`), event log, coalesced updates, live config (`watchConfigFile` polls `.agentguard.json`, `reloadConfig` applies it to monitor and circuit breaker). |
| `src/server.ts` | Hono app: request guards (Host, origin, token), routes, SSE, page delivery with nonce and CSP, `listenWatchdogServer` (loopback, port fallback). |
| `src/ui/commands.ts` | Command language shared by both terminal front ends: parse, run (destructive commands return a confirmation step), tab completion. |
| `src/ui/terminal.ts` | `renderFrame` (pure: state in, lines out) and `TerminalUI` (raw-mode input, alternate screen, restore on exit). |
| `src/ui/plain.ts` | Line output for pipes, logs, background jobs and `--no-tui`. |
| `src/ui/format.ts` | `sanitize`, truncation, colors (honors `NO_COLOR`), shared tables. |
| `src/ui/public/index.html` | The dashboard: one file, no build step. Placeholders `__LEASH_TOKEN__`, `__LEASH_VERSION__`, `__LEASH_NONCE__` are filled by the server. |
| `src/program.ts` | The CLI: commands (`watch`, `status`, `init`, `config show/set/unset`), argument validation, wiring, choice between full-screen and plain output, shutdown. |
| `src/cli.ts` / `src/index.ts` | Binary entry / library entry. Importing the library never starts anything. |

How the CLI picks its output: full-screen view when stdin and stdout are a terminal and the process is in the foreground; plain lines otherwise (pipe, file, background job, `--no-tui`). In plain mode commands are read from stdin; the end of stdin does not stop the watchdog.

## 5. Conventions

- TypeScript strict, ES module syntax, relative imports with the `.js` suffix, named exports only.
- English for code, comments, commit messages and documentation in this repository.
- Comments say why, not what. A safety rule in code names the failure it prevents.
- A new event type is added to `WatchEventType`; front ends color by `severity`, so they need no change.
- A new setting goes into `GuardLimits` (or `GuardConfig`), `CONFIG_KEY_INFO` and the settings table in the README in the same change; `agent-leash config` lists it from there.
- Paths inside the product are relative to the repository root with forward slashes. A backslash is a separator only on Windows (`toPosixPath`).
- No new runtime dependency without a reason that fits in one sentence. Runtime dependencies today: `commander`, `chokidar`, `hono`, `@hono/node-server`, `ps-list`.
- User-facing wording is plain and literal: say what will happen to which file or process.

## 6. Testing

- Tests live in `tests/*.test.ts` (Vitest). `tests/helpers/harness.ts` builds watcher, monitor and session with a fake process table and a fake killer; `tests/helpers/kill-guard.ts` is the suite-wide block on real kills.
- File tests use real temporary directories (`makeTmpDir`), git tests a real temporary repository. Time-dependent code uses fake timers or an injected `now`.
- `tests/cli.e2e.test.ts` starts the real CLI in a child process. Anything that could reach processes runs with `--demo`.
- The full-screen view is tested twice: `renderFrame` and `TerminalUI` against a fake terminal in Vitest, and by hand in a real pseudo-terminal with `scripts/scenarios/pty-drive.py`.
- The dashboard script is executed against a stand-in DOM (`tests/dashboard-page.test.ts`) to prove that hostile names stay text.
- A test name states the behavior. `it.todo` marks behavior that is not decided yet; do not turn one into a passing test by choosing the behavior yourself.
- For a safety fix, show once that the new test fails on the old code.
- Platform truth: verified on macOS. Linux paths exist (`/proc` lookup) but are unverified; Windows is not supported. Do not claim more in user-facing text.

## 7. Skills, subagents, hook

| What | Where | Use it when |
| :--- | :--- | :--- |
| Skill `scenario-testing` | `.agents/skills/scenario-testing/` | A change needs to be seen working end to end: terminal view, dashboard, package. |
| Skill `process-classification` | `.agents/skills/process-classification/` | You touch how agents are recognized, what counts as stale, frozen or standby, or what panic stops. |
| Skill `release-check` | `.agents/skills/release-check/` | The maintainer asks for a release, or to judge release readiness. |
| Subagent `scenario-tester` | `.claude/agents/scenario-tester.md` | The scenario pass should run in its own context and come back as a findings list. |
| Subagent `safety-reviewer` | `.claude/agents/safety-reviewer.md` | A diff touches rollback, termination, the server or anything rendered from watched data. |
| Hook `leash-guard` | `scripts/agents/leash-guard.mjs`, `.claude/settings.json` | Always on in Claude Code: asks before a kill/panic endpoint is called or the watchdog is started on this repo with auto-rollback. |

Skills are created and edited only in `.agents/skills/`, with `name` and `description` as their only frontmatter. `.claude/skills/` holds symlinks to them. `.agents/` contains no `AGENTS.md`.

## 8. Documentation

- [`README.md`](./README.md): what users read. Claims there must be true today.
- [`SECURITY.md`](./SECURITY.md): how to report a vulnerability privately.
