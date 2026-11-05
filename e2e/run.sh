#!/usr/bin/env bash
# Runs every OpenBooks browser test.
#
#   bash e2e/run.sh            (from the repository root, or `npm test` inside e2e/)
#
# Builds the Docker image, then gives each suite that needs a brand-new database its own fresh
# container on 127.0.0.1:$E2E_PORT. The bank-feeds suite runs the app directly with stand-in
# bank providers. Screenshots of failures go to e2e/output/.
#
# Settings (environment variables):
#   E2E_PORT        port for the test container (default 3999, so it won't clash with a running OpenBooks)
#   E2E_DOCKERFILE  Dockerfile to build (default: the repository's Dockerfile)
#   E2E_SKIP_BUILD  1 = reuse the existing openbooks:e2e image
#   E2E_SKIP_BANK   1 = skip the bank-feeds suite (it needs the backend's Python packages installed)
#   PYTHON          Python to run the bank-feeds server with (default python3)
#   SCREENSHOTS     1 = the crawl saves a screenshot of every page
set -uo pipefail

E2E="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$E2E")"
PORT="${E2E_PORT:-3999}"
BASE="http://127.0.0.1:$PORT"
IMAGE=openbooks:e2e
NAME=openbooks-e2e
OUT="$E2E/output"
PYTHON="${PYTHON:-python3}"
FAILED=()
SERVER_PID=""

mkdir -p "$OUT"
cleanup() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url
  for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "!! $1 did not come up" >&2
  return 1
}

fresh_container() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" "$IMAGE" >/dev/null && wait_for "$BASE/health"
}

suite() { # file
  echo
  echo "=== $1"
  if ! node "$E2E/suites/$1" "$BASE" "$OUT"; then FAILED+=("$1"); fi
}

if [ ! -d "$E2E/node_modules/playwright" ]; then
  echo "Installing Playwright…"
  (cd "$E2E" && npm install --no-audit --no-fund && npx playwright install chromium) || exit 1
fi

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  echo "Building $IMAGE…"
  docker build -q -f "${E2E_DOCKERFILE:-$ROOT/Dockerfile}" -t "$IMAGE" "$ROOT" >/dev/null || { echo "!! Docker build failed"; exit 1; }
fi

fresh_container || exit 1
suite 01-flows.js

fresh_container || exit 1
suite 02-crawl.js
suite 03-roles.js
suite 04-wide.js

if [ "${E2E_SKIP_BANK:-}" != "1" ]; then
  [ -d "$ROOT/frontend/dist" ] || (cd "$ROOT/frontend" && npm ci --no-audit --no-fund && npm run build) || exit 1
  DATA="$(mktemp -d)"
  BANK_PORT=$((PORT + 1))
  ADMIN_PASSWORD=password123 "$PYTHON" "$E2E/fake_provider_server.py" "$DATA" "$BANK_PORT" >"$OUT/bank-feeds-server.log" 2>&1 &
  SERVER_PID=$!
  if wait_for "http://127.0.0.1:$BANK_PORT/health"; then
    echo
    echo "=== 05-bank-feeds.js"
    node "$E2E/suites/05-bank-feeds.js" "http://127.0.0.1:$BANK_PORT" "$OUT" || FAILED+=("05-bank-feeds.js")
  else
    FAILED+=("05-bank-feeds.js (server did not start; see e2e/output/bank-feeds-server.log)")
  fi
  kill "$SERVER_PID" 2>/dev/null; SERVER_PID=""
  rm -rf "$DATA"
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All browser test suites passed."
else
  echo "Failed suites: ${FAILED[*]}"
  echo "Screenshots of failures are in e2e/output/"
  exit 1
fi
