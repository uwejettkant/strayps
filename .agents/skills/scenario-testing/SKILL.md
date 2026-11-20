---
name: scenario-testing
description: Verifies agent-leash end to end without endangering the machine it runs on. Covers the automated gate, the full-screen terminal view in a real pseudo-terminal, the web dashboard, the packed npm tarball and a read-only check against the real process table. Use after changes to the terminal view, dashboard, CLI or process handling, and before a release. Produces a findings list with evidence.
---

# Testing agent-leash end to end

The unit tests prove the parts. This pass proves what a user sees. Result: a findings list.

## 1. The one rule

agent-leash ends and pauses processes. The processes on this machine are live agent sessions, yours included.

- Commands that act on processes (`kill`, `pause`): only against `--demo`. Demo has its own fake process table and writes nothing.
- Real mode (no `--demo`): read the process list, never act on it. Run it in a sandbox directory (`scripts/scenarios/make-sandbox.sh`) when you need a config file to edit.
- Builds up to the tag `v0.1-full-guard` still watch files and answer kill and pause endpoints: do not start one for this pass.

## 2. The gate

```bash
npm run check
```

Typecheck for sources and tests, all tests, build. Stop here if it is red and report that.

## 3. Terminal pass (full-screen view)

The view needs a real terminal. `scripts/scenarios/pty-drive.py` provides one, types into it and prints the screen as text. Build first (`npm run build`).

Demo story and every command:

```bash
python3 scripts/scenarios/pty-drive.py --cols 112 --rows 30 -- \
  node dist/cli.js watch --demo --no-dashboard :: \
  wait:8.5 screen:story \
  type:help key:enter screen:help key:esc \
  type:revert key:enter screen:no-revert \
  type:"kill 31877" key:enter type:n \
  type:"kill 31877" key:enter type:y screen:killed \
  type:clean key:enter screen:no-clean \
  type:status key:enter screen:all-processes key:esc \
  type:pause key:enter screen:pause-prompt type:y screen:paused \
  type:resume key:enter screen:resumed \
  type:exit key:enter wait:1.5
```

Check on the screens: events appear oldest to newest; the metric row shows agents, MCP servers, what is left behind and what is paused, and nothing about files; `revert` answers that files are not watched any more and asks nothing; every destructive command shows `? … [y/N]` first; `n` changes nothing; after the second `kill 31877` that process is gone; `clean` answers that there is no bulk cleanup; no row says "safe to kill"; the pause prompt names the three processes of the demo agent (48110 and its two MCP servers); after `pause` they are still listed, marked as paused; `resume` continues them without a question.

Check in the result block: exit code 0, alternate screen left, cursor visible, line wrap on, terminal back in cooked mode. A terminal left in raw mode is a release blocker.

Ways out, each with its own run: `key:ctrl-c`, `key:ctrl-d`, `type:q key:enter`, `signal:TERM`, `signal:HUP`. All must end with exit code 0 and a restored terminal.

Sizes: repeat `screen` at `--cols 58 --rows 12`, `--cols 100 --rows 18`, `--cols 200 --rows 60`, and after `resize:90x20`. No line may wrap; process rows must show processes, not only a header.

Real mode in a sandbox (read-only):

```bash
SANDBOX=$(scripts/scenarios/make-sandbox.sh)
python3 scripts/scenarios/pty-drive.py --cols 120 --rows 30 --cwd "$SANDBOX" -- \
  node "$PWD/dist/cli.js" watch . --no-dashboard :: wait:8 screen:live type:status key:enter screen:list key:esc type:exit key:enter
```

The list shows the agents and MCP servers of this machine; your own session is marked `THIS REPO` only if it runs in the sandbox. Type nothing that ends or pauses.

Live configuration, same setup. From a second shell: `node dist/cli.js config set staleSessionHours 12 -C "$SANDBOX"`, then save broken JSON into `$SANDBOX/.agentguard.json`, then a valid file with `"agents": ["vibe"]`. Expected: a warning line `.agentguard.json reloaded: limits.staleSessionHours … → 12` in the activity list; the broken save is reported once and changes nothing; the agent list change is reported. `node dist/cli.js config "$SANDBOX"` lists each value with `(file)` or `(default)`. A file with an old `"mode"` or `"protectedFiles"` key still loads, with a notice that the key is ignored. With `--demo` instead, the file must stay byte for byte unchanged.

## 4. Plain output

No terminal means plain lines. Check with a pipe:

```bash
( sleep 3; echo status; sleep 1; echo exit ) | node dist/cli.js watch --demo --no-dashboard
node dist/cli.js watch --demo --no-dashboard < /dev/null &   # must keep running; stop it with kill -TERM
```

## 5. Dashboard pass (needs a browser tool)

Start `node dist/cli.js watch --demo --port 47381` and open `http://localhost:47381/`.

- No console errors; styles applied; `stream: connected`.
- A view only: no button, no dialog, no form. The header says to use the terminal for `kill`, `pause` and `resume`. No label says "safe to kill".
- The three cards show agent sessions, MCP servers and what is left behind, each with its memory; the paused demo processes show `PAUSED` after `pause` in the terminal.
- From a shell, each must answer 405 and change nothing: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47381/api/pause`, the same for `/api/kill/31877` and `/api/resume`.

Hostile text: the dashboard test (`tests/dashboard-page.test.ts`) feeds hostile command lines, directories and log messages through the page script. In the browser, check that `document.querySelectorAll('#process-list img, #activity-list img').length` is 0.

## 6. Package pass

```bash
scripts/scenarios/package-check.sh
```

Builds, packs, installs the tarball into an empty project, imports it as CommonJS and ESM, type-checks a consumer, runs the installed binary with `--demo`.

## 7. Reality check (read-only)

```bash
node dist/cli.js status
```

Read the table as a skeptic. On macOS every memory value of your own processes is the footprint, without `~`; compare one with Activity Monitor's Memory column. Is every agent you have open listed as one (CLI agents with MCP servers are found by those)? Is any editor, desktop app or dev server listed as an agent? For every `STALE` or `FROZEN` row: is it attached to an open application (`[VS Code]`, `[Claude Desktop]`)? Would the user be surprised if it died? Every surprise is a finding for `process-classification`, with the row as evidence. Do not paste full command lines into documents; they can contain tokens.

## 8. Findings list

One entry per finding:

- **What I ran** (command or steps)
- **Expected** / **Got** (with the output or screen excerpt that shows it)
- **Severity**: blocker (data loss, wrong kill, broken terminal, security), major, minor
- **Where** (file and line, if you looked)

End with what you did not check and why.
