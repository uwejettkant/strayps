---
name: process-classification
description: Rules and procedure for changing how agent-leash recognizes coding agents, classifies processes (ACTIVE, IDLE, STANDBY, STALE, FROZEN) and decides what pause holds. Use before touching src/core/process-monitor.ts (agent recognition, the keyword, launcher and host lists, the stale or silence thresholds, pause targets) or the wording of process labels.
---

# Changing process recognition and classification

A wrong label here once ended with a user clicking "Clean up" and losing a session they were working in. That happened twice. Since then nothing is labeled safe to kill and there is no bulk cleanup; the label comes back only when the classification is proven on sessions that are still in use. Treat every change as a change to what can get killed.

## 1. Which processes are agents

agent-leash keeps no list of AI products. A process is a coding agent when one of these holds, in this order:

| # | How | `detectedBy` |
| :--- | :--- | :--- |
| 1 | Its program name is built in: `claude`, `codex`, `aider` (`BUILT_IN_AGENT_NAMES`), or its path is a Claude Code install (`/claude-code/`, `anthropic.claude-code`, `/native-binary/claude`) | `name` |
| 2 | Its program name is in the `agents` setting of `.agentguard.json` | `setting` |
| 3 | It started an MCP server: the server's first ancestor that is not a launcher (shell, npm, npx, uvx, …) and not another MCP process | `mcp-client` |

- Names are matched exactly (`programNames`: the executable and, for an interpreter such as node or python, the script or `-m` module), never as a substring: "codex-mcp-server" is an MCP server, "aider-stats.js" is a script.
- Rule 3 never applies to an editor, a desktop app or a terminal (`HOST_PATTERNS`): VS Code, Cursor, the Antigravity app or Claude Desktop start MCP servers too, and they must never be stopped as an agent.
- Do not add a product name to the code because a new agent appeared. Rule 3 finds every agent that uses MCP; users name the rest with `agents`. A built-in name needs a real case that both miss.

### What else is listed

Besides agents, a process is listed when its command line names MCP (`mcp`, `modelcontextprotocol`: category `mcp`), or when an agent started it (category `child`): a dev server, a test watcher, a browser its MCP server opened. `child` is decided by the process tree alone, never by name:

- an agent is among its ancestors, and agent-leash itself is not (its `ps` and `lsof` calls, and the wrappers that started it, are never listed);
- it is at least `CHILD_MIN_AGE_SEC` (5 s) old by `ps etime`, so the shells, `git` and `rg` calls of a tool call do not flicker through the list; without a known age it is not listed;
- a launcher (`LAUNCHER_NAMES`: shell, npm, npx, uvx …) with a process under it is only that process's wrapper and is not listed.

A child has an `agentPid`, so it ends with its agent's session and is held by `pause` when its agent belongs to the watched repository. Once its agent is gone the tree no longer says whose it was, and it is not listed any more (no memory of origin). What the user started in a terminal, an editor or the Dock is never listed unless it is an agent or names MCP.

## 2. Classification

`ProcessMonitor.performScan` decides in this order; the first match wins:

| # | Condition | Result |
| :--- | :--- | :--- |
| 1 | dev server pattern, not in another repo | `ACTIVE` |
| 2 | working directory in another repo, older than `staleSessionHours` (6 h), **and** measured idle: watched for 10 min (`STALE_QUIET_SEC`), started no new child process in that window, and used less than 8 s CPU time in it (`STALE_CPU_BUDGET_SEC`) | `STALE` |
| 3 | MCP process, no resolvable working directory, not part of the watched session, older than `staleSessionHours`, measured idle as in rule 2, **and** not held by a running app (live parent chain under an editor or desktop `host`; a terminal, tmux or SSH session does not count) | `STALE` |
| 4 | orphaned: parent is PID 1 **and** not the leader of its own process group, not an agent, 0 % CPU, older than the silence timeout | `FROZEN` |
| 5 | MCP process, 0 % CPU, parent alive | `STANDBY` |
| 6 | agent that belongs to the watched repository | `ACTIVE` / `IDLE`, never stale or frozen |
| 7 | no CPU activity for the silence timeout (45 s) | `IDLE`, reason "Quiet …": quiet is not frozen |

`STALE` and `FROZEN` are observations shown to the user, with the reason. They never lead to a termination by themselves.

Activity is measured, not read from `ps %cpu`: the lister reads the CPU time a process has used (`ps -o time`, `parseCpuTime`), and the monitor compares it between scans (ACTIVE/IDLE) and over a sliding window (rules 2 and 3, samples every 30 s). Idle is not zero, which is why rule 2 has a budget instead of "no CPU at all". CPU time alone does not separate idle from working (idle claude sessions tick up to 6.5 s per 10 minutes, light work starts at about 4 s); the main sign of work is a new child process: a tool call starts a shell, `git`, `rg` or tests, and no idle session started any. The monitor remembers the descendants of each process (`trackChildren`); the ones there when watching starts, such as an agent's MCP servers, are not new, and agent-leash's own subtree (its `ps` calls) is left out. When the CPU time cannot be read, nothing is called stale; `ps %cpu` remains the fallback only for ACTIVE/IDLE on the first scan.

"Belongs to the watched repository" (`inWatchedRepo`) means: its own working directory is inside the repository, **or** one of its ancestors in the process tree is such a process. MCP servers often run in `/` or in their install directory; only the tree tells whose they are.

`agentPid` is the nearest monitored agent a process descends from. It also decides what ends with an agent (`WatchdogSession.getKillPlan`): every monitored process whose `agentPid` chain leads to it. A mistake in `agentPid` therefore changes what `kill` on an agent ends, not only what `pause` holds. `pauseTarget` is true for the agents of the watched repository and for the processes they started; `pause` holds exactly those (SIGSTOP) and `resume` continues them. A dev server started from the user's terminal, an editor and its MCP servers, and every session in another repository are never paused. A held process is never reported `STALE` or `FROZEN`.

`host` names the application a process tree hangs off (VS Code, Claude Desktop, a terminal …). It is shown to the user, keeps rule 3 of section 1 away from apps, and keeps rule 3 of section 2 away from MCP servers of an app that is still running. It changes nothing else in the classification.

Both thresholds are user settings: `limits.staleSessionHours` (default 6) and `limits.mcpSilenceTimeoutSec` (default 45) in `.agentguard.json`, applied to a running monitor by `setStaleSessionHours` / `setSilenceTimeoutSec` when the file changes; `agents` likewise by `setAgentNames`. A lower threshold makes more processes look stale, so a rule uses the configured value (`staleSessionSec`, `mcpSilenceTimeoutSec`), never the default as a literal.

## 3. Incidents (each has a regression test in `tests/process-control.test.ts`)

- **22,042 seconds.** After 6 h 7 min of work the active VS Code session of the watched repository was marked `STALE` during an idle moment and killed by the next cleanup. Fix: rule 6.
- **Its MCP server too.** The same session's MCP server was still marked `STALE` after 6 h when its working directory was not inside the repository (rule 3 ran before rule 5). Fix: `inWatchedRepo` through the process tree.
- **Different rules in tests.** The classification had branches that only ran with the real process lister, so the tests exercised other rules than production. Fix: one rule set; the lister and the working-directory lookup are injected separately.
- **Quiet is not frozen.** Every tracked process without CPU and file activity for 45 s was `FROZEN`: a resting `tsx watch` server, a browser, a young session in another repository waiting for its user. Fix: `FROZEN` only for orphans (rule 4); rule 7 now only says the process is quiet.
- **An app is not an orphan.** On macOS launchd (PID 1) is the parent of every app started from the Dock or Finder, so an idle browser app was called orphaned. launchd makes each one the leader of its own process group; a process whose parent died keeps the group it was started in. Measured on 19.11.2026: 727 of 732 PPID-1 processes led their own group, the other 5 were real orphans whose group leader was gone. Fix: rule 4 needs `pgid !== pid`; without a known group (fallback lister) nothing is called orphaned.
- **Busy, but stale by age.** A session in another repository counted as stale after 6 hours whatever it was doing, even at an open VS Code window. Measured on 19.11.2026 over 2 minutes: idle agent and MCP processes used 0.00 to 0.2 s of CPU time, working sessions 2 to 17 s. Fix: rule 2 and 3 need measured inactivity below a budget over a 10-minute window.
- **Every resting agent looked busy.** Measured on 20.11.2026 over 25 minutes, sessions opened, asked one question and left alone: idle `agy` used 0.8 to 1.0 s of CPU time per 10 minutes, idle `claude` in a terminal 1.4 to 5.5 s, idle `claude` in Claude Desktop 4.6 to 6.5 s, so with a budget of 0.5 s no forgotten agent was ever called stale. In 2 minutes the idle sessions started no process, a working one 124. Fix: the new-child-process rule, budget 8 s.
- **Idle under an open app.** On 20.11.2026, an MCP server of the open Antigravity app had no working directory, was 10 h old, and used 0.00 s CPU time in 10 min. It became `STALE` by rule 3, which runs before `STANDBY`. It was waiting for tool calls. Fix: rule 3 skips MCP servers whose parent chain is alive under an app `host`. Only a terminal-held or detached one can still be called stale.
- **Substrings listed the user's own processes.** Until 20.11.2026, `node`, `chromium` and `playwright` in a command line were categories of their own: a `tsx watch` server started from the user's terminal, a browser app from the Dock and an old test run appeared next to the agents, and a dev server the agent had started through `npm run dev` did not. Fix: those categories are gone; `child` follows the process tree (section 1, "What else is listed").
- **An agent nobody listed.** On 17.11.2026 the Antigravity CLI (`agy`) worked in the watched repository and did not appear at all; only its MCP server did. The emergency brake would have stopped the Claude session next to it, but not `agy`. Fix: rule 3 of section 1, without adding `agy` to any list.

## 4. Known weak spots (not decided yet)

- Rule 2 cannot tell a session nobody will come back to from one at an open editor window that is merely idle for 10 minutes: both start nothing and tick alike. It only rules out sessions that are working. An agent that thinks or streams for 10 minutes without a tool call and stays under 8 s is called stale (an observation, nothing is ended).
- A process that detached itself (its own process group, e.g. a daemonized server) and then lost its parent is not recognized as orphaned. On Linux an orphan may be adopted by a subreaper instead of PID 1 (unverified).
- MCP servers are still matched by substring (`mcp`) and catch unrelated programs; an agent without MCP and without a known name stays invisible until it is named in `agents`.
- An app that is not in `HOST_PATTERNS` and starts MCP servers (Docker Desktop, a launcher utility) is taken for an agent by rule 3 of section 1. Then every process it started is listed as its `child`, ends with it and is held by `pause` when it runs in the watched repository; the confirmation lists each one, but the cause is the misrecognition.
- A process an agent started and that outlived it (a dev server left running, an orphaned browser) is not listed at all unless it names MCP.

Do not settle these by yourself. Propose, with evidence.

## 5. Procedure for a change

1. **Start from a real case.** Take the process tree that was classified wrongly (`ps -Ao pid,ppid,etime,pcpu,comm` and the working directory), reduce it to the fields that matter, and remove anything private from command lines.
2. **Write the test first**, in `tests/process-control.test.ts`, as a small fake process table (`agent(...)`, `mcp(...)` helpers, a terminal tab for launchers). Run it against the current code and see it fail.
3. **Scan more than once.** A rule that holds on the first scan can flip after the silence timeout. Scan at `t0`, `t0 + 46 s` and far beyond.
4. **Change the rule**, keep the tables in this file current.
5. **Check the other direction.** A change that recognizes more must not turn an editor, an app or a dev server into an agent or a pause target; a change that protects more must not hide what is really orphaned.
6. **Look at reality, read-only:** `node dist/cli.js status` on a machine with several sessions open. Check every agent row (is it one?) and every row `pause` would hold. Never test a classification by killing.
7. **Wording.** Labels describe what is observed. A word that sounds like permission ("safe to kill", "reclaimable") comes back only together with evidence that it holds.
