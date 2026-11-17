---
name: process-classification
description: Rules and procedure for changing how agent-leash classifies processes (ACTIVE, IDLE, STANDBY, STALE, FROZEN) and what it labels safe to kill. Use before touching the classification in src/core/process-monitor.ts, the keyword and host lists, the stale or silence thresholds, or the wording of the safety labels.
---

# Changing process classification

A wrong label here ends with a user clicking "Clean up" and losing a session they were working in. That has happened twice. Treat every change as a change to what gets killed.

## 1. What exists

`ProcessMonitor.performScan` in `src/core/process-monitor.ts` decides in this order; the first match wins:

| # | Condition | Result |
| :--- | :--- | :--- |
| 1 | dev server pattern, not in another repo | `ACTIVE`, not offered for cleanup |
| 2 | working directory in another repo, older than `staleSessionHours` (6 h) | `STALE`, safe to kill |
| 3 | MCP process, no resolvable working directory, not part of the watched session, older than 6 h, CPU below 0.5 % | `STALE`, safe to kill |
| 4 | parent is PID 1, not an agent, 0 % CPU, older than the silence timeout | `FROZEN`, safe to kill |
| 5 | MCP process, 0 % CPU, parent alive | `STANDBY` |
| 6 | agent that belongs to the watched repository | `ACTIVE` / `IDLE`, never stale or frozen |
| 7 | no CPU and no file activity for the silence timeout (45 s) | `FROZEN`, safe to kill |

"Belongs to the watched repository" (`inWatchedRepo`) means: its own working directory is inside the repository, **or** one of its ancestors in the process tree is such a process. MCP servers often run in `/` or in their install directory; only the tree tells whose they are.

`host` names the application a process tree hangs off (VS Code, Claude Desktop, a terminal …). It is shown to the user and does not change the classification today.

## 2. Incidents (each has a regression test in `tests/process-control.test.ts`)

- **22,042 seconds.** After 6 h 7 min of work the active VS Code session of the watched repository was marked `STALE` during an idle moment and killed by the next cleanup. Fix: rule 6.
- **Its MCP server too.** The same session's MCP server was still marked `STALE` after 6 h when its working directory was not inside the repository (rule 3 ran before rule 5). Fix: `inWatchedRepo` through the process tree.
- **Different rules in tests.** The classification had branches that only ran with the real process lister, so the tests exercised other rules than production. Fix: one rule set; the lister and the working-directory lookup are injected separately.

## 3. Known weak spots (not decided yet)

- Rule 2 looks at age only. A session in another repository that is attached to an open editor window, or even busy, counts as stale after 6 hours.
- Rule 7 marks any other tracked process frozen after 45 quiet seconds: an idle `tsx watch` server, a browser whose name contains "chromium".
- CPU activity comes from `ps %cpu`: a decaying average on macOS, the lifetime average on Linux, where it says nothing about now.
- Process matching is by substring (`mcp`, `node`, `claude` …) and catches unrelated programs.

Do not settle these by yourself. Propose, with evidence.

## 4. Procedure for a change

1. **Start from a real case.** Take the process tree that was classified wrongly (`ps -Ao pid,ppid,etime,pcpu,comm` and the working directory), reduce it to the fields that matter, and remove anything private from command lines.
2. **Write the test first**, in `tests/process-control.test.ts`, as a small fake process table (`agent(...)`, `mcp(...)` helpers). Run it against the current code and see it fail.
3. **Scan more than once.** A rule that holds on the first scan can flip after the silence timeout. Scan at `t0`, `t0 + 46 s` and far beyond.
4. **Change the rule**, keep the order table in this file current.
5. **Check the other direction.** A change that protects more must not hide what is really orphaned: the tests for `STALE` in another repository and `FROZEN` orphans must still pass.
6. **Look at reality, read-only:** `node dist/cli.js status` on a machine with several sessions open. For every `SAFE TO KILL` row decide whether the user would agree. Never test a classification by killing.
7. **Wording.** "Safe to kill" is a promise. If a rule cannot keep it, the label has to change, not only the rule.
