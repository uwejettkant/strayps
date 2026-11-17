---
name: scenario-testing
description: Verifies agent-leash end to end without endangering the machine it runs on. Covers the automated gate, the full-screen terminal view in a real pseudo-terminal, the web dashboard, the packed npm tarball and a read-only check against the real process table. Use after changes to the terminal view, dashboard, CLI, rollback or process handling, and before a release. Produces a findings list with evidence.
---

# Testing agent-leash end to end

The unit tests prove the parts. This pass proves what a user sees. Result: a findings list.

## 1. The one rule

agent-leash kills processes and rewrites files. The processes on this machine are live agent sessions, yours included.

- Destructive commands (`kill`, `clean`, `panic`) and endpoints (`/api/kill/*`, `/api/kill-frozen`, `/api/panic`): only against `--demo`. Demo has its own fake process table and writes nothing.
- Real mode (no `--demo`): only in a sandbox directory, and only file scenarios (edit, revert, thrash). Read the process list, never act on it.
- Never watch a repository someone is working in with auto-rollback on.

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
  type:mo key:tab type:str key:tab key:enter screen:mode \
  type:"revert cli" key:tab key:enter screen:confirm type:y screen:reverted \
  type:"kill 31877" key:enter type:n \
  type:clean key:enter type:y screen:cleaned \
  type:status key:enter screen:all-processes key:esc \
  type:panic key:enter type:y screen:panic \
  type:exit key:enter wait:1.5
```

Check on the screens: events appear oldest to newest; the breaker shows `TRIPPED` after the sixth edit; every destructive command shows `? … [y/N]` first; `n` changes nothing; after `clean` the two stale processes are gone; after `panic` only the processes of the other repository remain.

Check in the result block: exit code 0, alternate screen left, cursor visible, line wrap on, terminal back in cooked mode. A terminal left in raw mode is a release blocker.

Ways out, each with its own run: `key:ctrl-c`, `key:ctrl-d`, `type:q key:enter`, `signal:TERM`, `signal:HUP`. All must end with exit code 0 and a restored terminal.

Sizes: repeat `screen` at `--cols 58 --rows 12`, `--cols 100 --rows 18`, `--cols 200 --rows 60`, and after `resize:90x20`. No line may wrap; process rows must show processes, not only a header.

Real mode in a sandbox (file scenarios only):

```bash
SANDBOX=$(scripts/scenarios/make-sandbox.sh)
python3 scripts/scenarios/pty-drive.py --cols 120 --rows 30 --cwd "$SANDBOX" -- \
  node "$PWD/dist/cli.js" watch . --no-dashboard :: wait:8 screen:live type:exit key:enter
```

While it waits, edit files in `$SANDBOX` from a second shell: one normal edit, `.env`, `docker-compose.yml`, six quick edits of one file. Expected: the edit appears; `.env` warns and stays changed; `docker-compose.yml` is reverted; the sixth edit trips the breaker and the file is back at its committed content. The exit summary names the directory with the kept copies; look into it.

## 4. Plain output

No terminal means plain lines. Check with a pipe:

```bash
( sleep 3; echo status; sleep 1; echo exit ) | node dist/cli.js watch --demo --no-dashboard
node dist/cli.js watch --demo --no-dashboard < /dev/null &   # must keep running; stop it with kill -TERM
```

## 5. Dashboard pass (needs a browser tool)

Start `node dist/cli.js watch --demo --port 47381` and open `http://localhost:47381/`.

- No console errors; styles applied; `stream: connected`.
- Mode buttons switch the mode. `revert` on an event works. `Kill PID` on a process that is not stale opens the dialog first. `Clean Up` opens the dialog and names the count. The panic dialog cancels and confirms.
- From a shell: `curl -X POST http://127.0.0.1:47381/api/mode -d '{"mode":"yolo"}'` must answer 403 (no token).

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

Read the table as a skeptic. For every row marked `SAFE TO KILL`: is it attached to an open application (`[VS Code]`, `[Claude Desktop]`)? Would the user be surprised if it died? Every such row is a finding for `process-classification`, with the row as evidence. Do not paste full command lines into documents; they can contain tokens.

## 8. Findings list

One entry per finding:

- **What I ran** (command or steps)
- **Expected** / **Got** (with the output or screen excerpt that shows it)
- **Severity**: blocker (data loss, wrong kill, broken terminal, security), major, minor
- **Where** (file and line, if you looked)

End with what you did not check and why.
