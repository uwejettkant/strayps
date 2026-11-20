---
name: scenario-testing
description: Verifies agent-leash end to end without endangering the machine it runs on. Covers the automated gate, the full-screen terminal view in a real pseudo-terminal, the web dashboard, the packed npm tarball and a read-only check against the real process table. Use after changes to the terminal view, dashboard, CLI, rollback or process handling, and before a release. Produces a findings list with evidence.
---

# Testing agent-leash end to end

The unit tests prove the parts. This pass proves what a user sees. Result: a findings list.

## 1. The one rule

agent-leash kills processes and rewrites files. The processes on this machine are live agent sessions, yours included.

- Commands that act on processes (`kill`, `pause`) and endpoints (`/api/kill/*`, `/api/pause`): only against `--demo`. Demo has its own fake process table and writes nothing.
- Real mode (no `--demo`): only in a sandbox directory, and only file scenarios (edit, revert, thrash). Read the process list, never act on it.
- Never confirm `revert` on a repository someone is working in. (The watchdog itself never rolls back; builds before 19.11.2026 still do: never leave one running on a working repository.)

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
  type:"revert cli" key:tab key:enter screen:confirm type:y screen:reverted \
  type:"kill 31877" key:enter type:n \
  type:"kill 31877" key:enter type:y screen:killed \
  type:clean key:enter screen:no-clean \
  type:status key:enter screen:all-processes key:esc \
  type:pause key:enter screen:pause-prompt type:y screen:paused \
  type:resume key:enter screen:resumed \
  type:exit key:enter wait:1.5
```

Check on the screens: events appear oldest to newest; the breaker shows `TRIPPED` after the sixth edit; every destructive command shows `? … [y/N]` first; `n` changes nothing; after the second `kill 31877` that process is gone; `clean` answers that there is no bulk cleanup; no row says "safe to kill"; the pause prompt names the three processes of the demo agent (48110 and its two MCP servers); after `pause` they are still listed, marked as paused, and no file event appears; `resume` continues them without a question.

Check in the result block: exit code 0, alternate screen left, cursor visible, line wrap on, terminal back in cooked mode. A terminal left in raw mode is a release blocker.

Ways out, each with its own run: `key:ctrl-c`, `key:ctrl-d`, `type:q key:enter`, `signal:TERM`, `signal:HUP`. All must end with exit code 0 and a restored terminal.

Sizes: repeat `screen` at `--cols 58 --rows 12`, `--cols 100 --rows 18`, `--cols 200 --rows 60`, and after `resize:90x20`. No line may wrap; process rows must show processes, not only a header.

Real mode in a sandbox (file scenarios only):

```bash
SANDBOX=$(scripts/scenarios/make-sandbox.sh)
python3 scripts/scenarios/pty-drive.py --cols 120 --rows 30 --cwd "$SANDBOX" -- \
  node "$PWD/dist/cli.js" watch . --no-dashboard :: wait:8 screen:live type:exit key:enter
```

While it waits, edit files in `$SANDBOX` from a second shell: one normal edit, `.env`, `docker-compose.yml`, six quick edits of one file. Expected: the edit appears; `.env` warns and stays changed; `docker-compose.yml` raises a critical alarm and stays as written; the sixth edit trips the breaker with exactly one alarm, further edits raise none, the file stays as written. Then `revert docker-compose.yml` and `revert <file>` (each confirmed) restore the version before the latest series, and the breaker shows `armed` again. Edit a file, wait over a minute, edit it again, `revert` it: it must come back to the first edit, not to the committed content. The exit summary names the directory with the kept copies; look into it.

Live configuration, same setup. From the second shell: `node dist/cli.js config set maxFilesWarn 30 -C "$SANDBOX"`, then save broken JSON into `$SANDBOX/.agentguard.json`, then a valid file with fewer `protectedFiles`. Expected: a warning line `.agentguard.json reloaded: limits.maxFilesWarn … → 30` and the header shows `warn 30`; the broken save is reported once and changes nothing; the shorter list is reported as `no longer protected: …`. `node dist/cli.js config "$SANDBOX"` lists each value with `(file)` or `(default)`. A file with an old `"mode"` key still loads, with a notice that the key is ignored. With `--demo` instead, the file must stay byte for byte unchanged.

## 4. Plain output

No terminal means plain lines. Check with a pipe:

```bash
( sleep 3; echo status; sleep 1; echo exit ) | node dist/cli.js watch --demo --no-dashboard
node dist/cli.js watch --demo --no-dashboard < /dev/null &   # must keep running; stop it with kill -TERM
```

## 5. Dashboard pass (needs a browser tool)

Start `node dist/cli.js watch --demo --port 47381` and open `http://localhost:47381/`.

- No console errors; styles applied; `stream: connected`.
- `revert` on an event and `Kill PID` / `End session` on any process open the dialog first (`End session` lists every process that ends with the agent), cancel changes nothing, confirm acts. Pause names the processes it holds, cancels and confirms; while something is held the button reads Resume and continues without a dialog. A `rollback` line has no `revert` button. No button or label offers a bulk cleanup or says "safe to kill".
- From a shell: `curl -X POST http://127.0.0.1:47381/api/rollback-file -d '{"filePath":"a.ts"}'` must answer 403 (no token).

Hostile names, in a sandbox without `--demo` (read the page, click nothing that kills):

```bash
cd "$SANDBOX" && printf 'x\n' > "src/<img src=x onerror=document.title='XSS'>.ts"
```

The name must appear as text; the page title must not change; `document.querySelectorAll('#activity-list img').length` must be 0.

## 6. Package pass

```bash
scripts/scenarios/package-check.sh
```

Builds, packs, installs the tarball into an empty project, imports it as CommonJS and ESM, type-checks a consumer, runs the installed binary with `--demo`.

## 7. Reality check (read-only)

```bash
node dist/cli.js status
```

Read the table as a skeptic. Is every agent you have open listed as one (CLI agents with MCP servers are found by those)? Is any editor, desktop app or dev server listed as an agent? For every `STALE` or `FROZEN` row: is it attached to an open application (`[VS Code]`, `[Claude Desktop]`)? Would the user be surprised if it died? Every surprise is a finding for `process-classification`, with the row as evidence. Do not paste full command lines into documents; they can contain tokens.

## 8. Findings list

One entry per finding:

- **What I ran** (command or steps)
- **Expected** / **Got** (with the output or screen excerpt that shows it)
- **Severity**: blocker (data loss, wrong kill, broken terminal, security), major, minor
- **Where** (file and line, if you looked)

End with what you did not check and why.
