#!/bin/bash
# Creates a throwaway git repository to point the watchdog at, and prints its path.
#
#   SANDBOX=$(scripts/scenarios/make-sandbox.sh)
#   node dist/cli.js watch "$SANDBOX" --port 47321
#
# Contents: two source files, a .env (gitignored), a docker-compose.yml (protected by default),
# a gitignored data file and one committed baseline. Everything lives under the system temp dir.
set -euo pipefail

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/agent-leash-sandbox-XXXXXX")
cd "$SANDBOX"
git init -q
git config user.email sandbox@example.com
git config user.name Sandbox
git config commit.gpgsign false
mkdir -p src data
printf 'export const a = 1;\n' > src/a.ts
printf 'export const b = 1;\n' > src/b.ts
printf 'SECRET=initial\n' > .env
printf 'version: "3.8"\n' > docker-compose.yml
printf 'node_modules/\n.env\ndata/\n' > .gitignore
printf 'local database bytes\n' > data/dev.db
git add -A
git commit -qm "sandbox baseline"
# the real path, so it compares equal to what the watchdog and lsof report (/tmp is a symlink on macOS)
pwd -P
