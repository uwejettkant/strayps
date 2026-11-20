#!/bin/bash
# Checks the package the way a user gets it: build, pack, install the tarball into an empty
# project, then import it (CommonJS and ESM), type-check a consumer and run the binary.
#
#   scripts/scenarios/package-check.sh
#
# Needs network access once (installs the runtime dependencies of the tarball plus typescript).
# Runs the installed binary only with --demo, which touches no files and no real processes.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/agent-leash-package-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; exit 1; }

cd "$ROOT"
npm run build --silent >/dev/null
npm pack --silent --pack-destination "$WORK" >/dev/null
TARBALL=$(ls "$WORK"/agent-leash-*.tgz)
echo "Tarball: $(basename "$TARBALL") ($(du -k "$TARBALL" | cut -f1) KB)"
tar -tzf "$TARBALL" | sed 's/^/    /'

EXPECTED_VERSION=$(node -p "require('$ROOT/package.json').version")
mkdir "$WORK/consumer" && cd "$WORK/consumer"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$TARBALL" typescript@5 @types/node@22 >/dev/null

[ "$(node -e 'process.stdout.write(require("agent-leash").getVersion())')" = "$EXPECTED_VERSION" ] \
  && pass "require('agent-leash') works and reports $EXPECTED_VERSION" || fail "CommonJS require"

node --input-type=module -e 'import { ProcessMonitor, WatchdogSession, listenWatchdogServer } from "agent-leash"; if (![ProcessMonitor, WatchdogSession, listenWatchdogServer].every((x) => typeof x === "function")) process.exit(1)' \
  && pass "ESM named imports work" || fail "ESM import"

printf 'require("agent-leash"); console.log("still mine");\n' > my-cli.js
[ "$(node my-cli.js watch . 2>&1)" = "still mine" ] \
  && pass "importing the library does not start the CLI" || fail "import started the CLI"

cat > consumer.ts <<'TS'
import { GuardConfigManager, ProcessMonitor, type StatusSnapshot, WatchdogSession, listenWatchdogServer } from 'agent-leash';
export async function embed(rootDir: string) {
  const configManager = new GuardConfigManager(rootDir);
  const processMonitor = new ProcessMonitor({ rootDir });
  const session = new WatchdogSession({ rootDir, configManager, processMonitor });
  session.on('update', (snapshot: StatusSnapshot) => snapshot.processes.length);
  return listenWatchdogServer({ rootDir, configManager, processMonitor, session });
}
TS
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck false consumer.ts \
  && pass "types resolve for a strict TypeScript consumer (nodenext)" || fail "types (nodenext)"
npx tsc --noEmit --strict --module commonjs --moduleResolution node10 --target es2022 --esModuleInterop consumer.ts \
  && pass "types resolve for a CommonJS TypeScript consumer (node10)" || fail "types (node10)"

[ "$(./node_modules/.bin/agent-leash --version)" = "$EXPECTED_VERSION" ] \
  && pass "installed binary runs" || fail "binary --version"

mkdir "$WORK/elsewhere" && cd "$WORK/elsewhere"
( sleep 2.5; echo exit ) | "$WORK/consumer/node_modules/.bin/agent-leash" watch --demo --port 0 > run.log 2>&1 &
RUN=$!
for _ in $(seq 1 40); do grep -q 'Dashboard:   http' run.log 2>/dev/null && break; sleep 0.1; done
URL=$(sed -n 's/.*Dashboard:   \(http[^ ]*\).*/\1/p' run.log | sed 's/localhost/127.0.0.1/')
curl -s "$URL/" | grep -q 'id="process-list"' \
  && pass "dashboard page is served from the installed package" || fail "dashboard page"
wait "$RUN" && grep -q 'agent-leash stopped after' run.log \
  && pass "installed binary stops cleanly on 'exit'" || fail "exit via stdin"

echo "Package check passed."
