# Contributing to strayps

Thank you for your interest in contributing to `strayps`. Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

## Development Setup

`strayps` supports Node.js `>=20.0.0` at runtime, while local development and the Vitest test runner require **Node.js 22.12 or newer** (macOS is verified; Linux paths exist but are unverified; Windows is not supported).

```bash
git clone https://github.com/uwejettkant/strayps.git
cd strayps
npm ci
```

Useful scripts during development:

```bash
npm run demo      # simulated session: fake agent, fake processes, nothing touched
npm run dev       # run strayps on this repository from the sources
npm run check     # typecheck, all tests, and build — required before every PR
```

> **Safety note:** Never aim `kill` or `pause` at the real process table while testing changes. Use `--demo` or the test harness (`createHarness()` in `tests/helpers/harness.ts`).

## Making Changes

1. Create a branch from `main` using `feature/<topic>` or `fix/<topic>`.
2. Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat: ...`, `fix: ...`, `docs: ...`).
3. Add or update tests in `tests/` for your changes.
4. Run `npm run check` and make sure typecheck, tests, and build all pass.
5. Open a Pull Request against `main` using the PR template.

If you are using a coding agent, see [`AGENTS.md`](./AGENTS.md) for the repository rules and safety invariants.

## Reporting Bugs & Security Issues

- **Bugs and feature requests:** Open a [GitHub Issue](https://github.com/uwejettkant/strayps/issues). Do not paste real process command lines that may contain secrets.
- **Security vulnerabilities:** Do not open a public issue. Follow [`SECURITY.md`](./SECURITY.md) and use GitHub's private vulnerability reporting.
