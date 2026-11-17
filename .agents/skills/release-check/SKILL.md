---
name: release-check
description: Checks whether agent-leash is ready to be published to npm and GitHub, and prepares a release without publishing it. Verifies the gate, the packed tarball, version and README facts, open audit items and package metadata. Use when the maintainer asks for a release, a version bump, or an assessment of release readiness. Never pushes, tags or publishes.
---

# Release check

You prepare and report. Pushing, tagging, `npm publish` and creating a GitHub release happen only after the maintainer says so, in that conversation.

## 1. Blockers first

A release is blocked while any of these is true:

- the maintainer has named a known problem a release blocker (once the repository is public: an open issue with the label `release-blocker`),
- an `it.todo` in the tests covers behavior that the README describes as done,
- `npm run check` is red.

List what blocks and stop if anything does. Do not work around undecided behavior by deciding it yourself.

## 2. Facts in the README

Every number and claim is checked against a command, not against memory:

| Claim | Check |
| :--- | :--- |
| test count | `npm test` (count passed, state todos separately) |
| bundle size | `npm run build` (`dist/index.js` + `dist/cli.js`) and `npm pack --dry-run` (tarball size) |
| version badge | `node -p "require('./package.json').version"` |
| supported platforms | what was actually run: see AGENTS.md, section 6 |
| "100% local" | `grep -n "https\?://" src/ui/public/index.html` must show no external script or style |
| CLI flags and commands | `node dist/cli.js --help`, `node dist/cli.js watch --help` |
| library example | `scripts/scenarios/package-check.sh` compiles an equivalent consumer |

A claim that cannot be shown is removed or reworded.

## 3. Package

```bash
npm run check
scripts/scenarios/package-check.sh
npm pack --dry-run
npm audit --omit=dev
```

- The tarball contains `dist/`, `src/ui/public/index.html`, `README.md`, `LICENSE`, `package.json` and nothing else.
- `package.json` has `repository`, `bugs`, `homepage`, and an `engines` range that matches what was tested.
- Images in the README resolve on npm (absolute URLs, or the files are in the tarball).
- `npm audit --omit=dev` shows nothing for runtime dependencies.
- The package name on npm: checking it sends the name to the registry. Ask the maintainer before the first lookup.
- `SECURITY.md` exists, and private vulnerability reporting is switched on for the GitHub repository.

## 4. Scenario pass

Run the skill `scenario-testing` (or the subagent `scenario-tester`). No blocker findings.

## 5. Version and notes

- Bump `version` in `package.json` only (it is the single source).
- Write the changelog entry from the commits since the last tag: what users notice, breaking changes first.
- Demo assets (`assets/demo.svg`, `assets/demo.tape`) show the current terminal view.

## 6. Report

State: ready or not, the blockers, what you verified with which command, what you could not verify. Then wait for the maintainer.
