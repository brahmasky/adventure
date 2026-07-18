#!/bin/bash
# Set up Houge's always-on daemon on a NEW host (e.g. migrating MacBook Pro -> Mac mini).
# Run this ON THE NEW HOST, inside a fresh clone of the repo. It does the safe, automatable
# parts (toolchain check, build, ollama model, generate + stage the launchd plist) and then
# PRINTS the human-coordinated cutover steps (copy state, load the service, verify) — it does
# NOT start the daemon, because only ONE daemon may long-poll the Telegram bot at a time.
#
#   Usage:  bash deploy/launchd/setup-new-host.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
echo "== Houge new-host setup =="
echo "project: $PROJECT_DIR"
echo "host:    $(scutil --get ComputerName 2>/dev/null || hostname)  user: $(whoami)"

# 1. Prerequisite toolchain — Houge shells these; report anything missing.
echo; echo "-- prerequisites --"
BIN_DIRS=""
missing=0
for c in git node npm docker codex pi agy ollama; do
  if p="$(command -v "$c" 2>/dev/null)"; then
    printf "  ok   %-7s %s\n" "$c" "$p"
    BIN_DIRS="$BIN_DIRS $(dirname "$p")"
  else
    printf "  MISS %-7s (install before starting the daemon)\n" "$c"
    missing=1
  fi
done
[ "$missing" = 1 ] && echo "  !! install the MISS tools (docker+codex are required for external_work; ollama for episodic memory)."

# 2. Build.
echo; echo "-- build --"
npm ci
npm run build

# 3. Local embedding model (episodic memory) — best-effort.
if command -v ollama >/dev/null 2>&1; then
  echo; echo "-- ollama embeddinggemma (episodic) --"
  ollama pull embeddinggemma 2>&1 | tail -1 || echo "  (pull failed — episodic degrades to BM25 until available)"
fi

# 4. Generate the launchd plist from the template with THIS host's paths.
#    PATH must include every CLI dir (node/docker/codex/pi/agy) so the daemon's children find them.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
EXTRA_PATH="$(printf '%s\n' $BIN_DIRS | sort -u | tr '\n' ':' | sed 's/:$//')"
PLIST_OUT="$PROJECT_DIR/deploy/launchd/com.houge.daemon.plist"
sed -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" \
    -e "s#__NODE_BIN_DIR__#${EXTRA_PATH:-$NODE_BIN_DIR}#g" \
    "$PROJECT_DIR/deploy/launchd/com.houge.daemon.plist.template" > "$PLIST_OUT"
mkdir -p "$PROJECT_DIR/logs"
echo; echo "-- generated $PLIST_OUT (PATH=${EXTRA_PATH:-$NODE_BIN_DIR}:...) --"

cat <<EOF

=====================================================================
 REMAINING (human-coordinated cutover — do these in order):

 A. On the OLD host: STOP its daemon so only one polls Telegram:
      launchctl bootout gui/\$(id -u)/com.houge.daemon

 B. Copy the non-git STATE from the old host to THIS host's project dir:
      - houge.sqlite   (all memory/lessons/wiki/ledger/chat — the crown jewel)
      - .env           (secrets + config)
      - memory/wiki/   (runtime wiki pages)
    e.g. from the old host:
      scp houge.sqlite .env $(whoami)@$(hostname):"$PROJECT_DIR"/
      scp -r memory/wiki  $(whoami)@$(hostname):"$PROJECT_DIR"/memory/

 C. Adjust .env CLI paths to THIS host (HOUGE_CODEX_BIN / HOUGE_AGY_BIN /
    HOUGE_KIMI_CLI_BIN) — compare against the 'ok' paths printed above.

 D. Install + start the service on THIS host:
      cp deploy/launchd/com.houge.daemon.plist ~/Library/LaunchAgents/
      launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.houge.daemon.plist

 E. Verify: tail -f logs/houge-daemon.err.log ; npm run houge -- status ;
    send a Telegram message; confirm houge.sqlite row counts match the old host.
=====================================================================
EOF
