# AGENTS.md — agent-leash

## Overview
`agent-leash` is a TypeScript CLI and local Hono Web Dashboard that monitors repositories during autonomous AI coding sessions and local MCP server runs.

## Tech Stack
- **Runtime**: Node.js LTS (>= 20 / 22 LTS), TypeScript (strict)
- **CLI**: `commander` (`src/cli.ts`)
- **HTTP & Real-Time Stream**: `hono`, `@hono/node-server` (`src/server.ts`, SSE `/api/events`)
- **File Monitoring**: `chokidar` (`src/core/watcher.ts`)
- **Process Monitoring**: `ps-list` + POSIX `ps` fallback (`src/core/process-monitor.ts`)
- **Build & Test**: `tsup` (CJS + `.d.ts`), `vitest` (`tests/*.test.ts`)

## Commands
- `npm test` — Run all automated unit and API tests (`vitest run`)
- `npm run build` — Build `./dist/cli.js` and `./dist/cli.d.ts` (`tsup src/cli.ts --format cjs --dts --clean`)
- `npm run dev` — Run the CLI in development mode (`tsx src/cli.ts watch`)

## Architecture & Conventions
- `src/core/guard-config.ts`: Manages `.agentguard.json` defaults, glob matching, and mode policies (`strict`, `balanced`, `yolo`).
- `src/core/loop-detector.ts`: Sliding 60-second window per file path to trip the circuit breaker when `maxEditsPerFilePerMinute` is exceeded.
- `src/core/watcher.ts`: Chokidar file watcher with session checkpointing (`git stash create` / `HEAD` + in-memory snapshot) and self-write suppression during rollbacks.
- `src/core/process-monitor.ts`: Polls every 2s for `mcp` and agent child processes; tracks CPU/file activity heartbeat and flags processes silent beyond `mcpSilenceTimeoutSec` as `FROZEN`.
- `src/ui/public/index.html`: Single-page console dashboard following the "Uwe Jettkant Konsole" dark terminal design tokens (`#080B09`, `#0D120F`, `#5BE49B`).
