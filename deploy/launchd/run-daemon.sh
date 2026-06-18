#!/bin/bash
# Wrapper launchd execs to run the Houge always-on daemon.
# Resolves the project root from this script's location, then runs the daemon
# in the foreground (launchd supervises the process; KeepAlive restarts it).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

# Share one .env unless the caller already pointed HOUGE_ENV_FILE elsewhere.
export HOUGE_ENV_FILE="${HOUGE_ENV_FILE:-$PROJECT_DIR/.env}"

exec npm run --silent houge -- telegram-poll
