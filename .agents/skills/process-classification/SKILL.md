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

## 2. Classification

`ProcessMonitor.performScan` decides in this order; the first match wins:

| # | Condition | Result |
| :--- | :--- | :--- |
| 1 | dev server pattern, not in another repo | `ACTIVE` |
| 2 | working directory in another repo, older than `staleSessionHours` (6 h) | `STALE` |
| 3 | MCP process, no resolvable working directory, not part of the watched session, older than `staleSessionHours`, CPU below 0.5 % | `STALE` |
| 4 | orphaned: parent is PID 1 **and** not the leader of its own process group, not an agent, 0 % CPU, older than the silence timeout | `FROZEN` |
| 5 | MCP process, 0 % CPU, parent alive | `STANDBY` |
| 6 | agent that belongs to the watched repository | `ACTIVE` / `IDLE`, never stale or frozen |
| 7 | no CPU and no file activity for the silence timeout (45 s) | `IDLE`, reason "Quiet …": quiet is not frozen |

`STALE` and `FROZEN` are observations shown to the user, with the reason. They never lead to a termination by themselves.

"Belongs to the watched repository" (`inWatchedRepo`) means: its own working directory is inside the repository, **or** one of its ancestors in the process tree is such a process. MCP servers often run in `/` or in their install directory; only the tree tells whose they are.

`agentPid` is the nearest monitored agent a process descends from. `pauseTarget` is true for the agents of the watched repository and for the processes they started; `pause` holds exactly those (SIGSTOP) and `resume` continues them. A dev server started from the user's terminal, an editor and its MCP servers, and every session in another repository are never paused. A held process is never reported `STALE` or `FROZEN`.

`host` names the application a process tree hangs off (VS Code, Claude Desktop, a terminal …). It is shown to the user, keeps rule 3 of section 1 away from apps, and does not change the classification.

Both thresholds are user settings: `limits.staleSessionHours` (default 6) and `limits.mcpSilenceTimeoutSec` (default 45) in `.agentguard.json`, applied to a running monitor by `setStaleSessionHours` / `setSilenceTimeoutSec` when the file changes; `agents` likewise by `setAgentNames`. A lower threshold makes more processes look stale, so a rule uses the configured value (`staleSessionSec`, `mcpSilenceTimeoutSec`), never the default as a literal.

## 3. Incidents (each has a regression test in `tests/process-control.test.ts`)

- **22,042 seconds.** After 6 h 7 min of work the active VS Code session of the watched repository was marked `STALE` during an idle moment and killed by the next cleanup. Fix: rule 6.
- **Its MCP server too.** The same session's MCP server was still marked `STALE` after 6 h when its working directory was not inside the repository (rule 3 ran before rule 5). Fix: `inWatchedRepo` through the process tree.
- **Different rules in tests.** The classification had branches that only ran with the real process lister, so the tests exercised other rules than production. Fix: one rule set; the lister and the working-directory lookup are injected separately.
- **Quiet is not frozen.** Every tracked process without CPU and file activity for 45 s was `FROZEN`: a resting `tsx watch` server, a browser, a young session in another repository waiting for its user (audit D-02). Fix: `FROZEN` only for orphans (rule 4); rule 7 now only says the process is quiet.
- **An app is not an orphan.** On macOS launchd (PID 1) is the parent of every app started from the Dock or Finder, so an idle browser app was called orphaned. launchd makes each one the leader of its own process group; a process whose parent died keeps the group it was started in. Measured on 19.11.2026: 727 of 732 PPID-1 processes led their own group, the other 5 were real orphans whose group leader was gone. Fix: rule 4 needs `pgid !== pid`; without a known group (fallback lister) nothing is called orphaned.
- **An agent nobody listed.** On 17.11.2026 the Antigravity CLI (`agy`) worked in the watched repository and did not appear at all; only its MCP server did. The emergency brake would have stopped the Claude session next to it, but not `agy`. Fix: rule 3 of section 1, without adding `agy` to any list.

## 4. Known weak spots (not decided yet)

- Rule 2 looks at age only. A session in another repository that is attached to an open editor window, or even busy, counts as stale after 6 hours.
- CPU activity comes from `ps %cpu`: a decaying average on macOS, the lifetime average on Linux, where it says nothing about now.
- A process that detached itself (its own process group, e.g. a daemonized server) and then lost its parent is not recognized as orphaned. On Linux an orphan may be adopted by a subreaper instead of PID 1 (unverified).
- MCP servers, browsers and node processes are still matched by substring (`mcp`, `chromium`, `node` …) and catch unrelated programs; an agent without MCP and without a known name stays invisible until it is named in `agents`.
- An app that is not in `HOST_PATTERNS` and starts MCP servers (Docker Desktop, a launcher utility) is taken for an agent by rule 3 of section 1.

Do not settle these by yourself. Propose, with evidence.

## 5. Procedure for a change

1. **Start from a real case.** Take the process tree that was classified wrongly (`ps -Ao pid,ppid,etime,pcpu,comm` and the working directory), reduce it to the fields that matter, and remove anything private from command lines.
2. **Write the test first**, in `tests/process-control.test.ts`, as a small fake process table (`agent(...)`, `mcp(...)` helpers, a terminal tab for launchers). Run it against the current code and see it fail.
3. **Scan more than once.** A rule that holds on the first scan can flip after the silence timeout. Scan at `t0`, `t0 + 46 s` and far beyond.
4. **Change the rule**, keep the tables in this file current.
5. **Check the other direction.** A change that recognizes more must not turn an editor, an app or a dev server into an agent or a pause target; a change that protects more must not hide what is really orphaned.
6. **Look at reality, read-only:** `node dist/cli.js status` on a machine with several sessions open. Check every agent row (is it one?) and every row `pause` would hold. Never test a classification by killing.
7. **Wording.** Labels describe what is observed. A word that sounds like permission ("safe to kill", "reclaimable") comes back only together with evidence that it holds.
