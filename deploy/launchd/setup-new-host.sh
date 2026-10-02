#!/bin/bash
# Set up Houge's always-on daemon on a NEW host (e.g. migrating MacBook Pro -> Mac mini).
# Run this ON THE NEW HOST, inside a fresh clone of the repo. It does the safe, automatable
# parts (toolchain check, build, ollama model, generate + stage the launchd plist) and then
# PRINTS the human-coordinated cutover steps (copy state, load the service, verify) — it does
# NOT start the daemon, because only ONE daemon may long-poll the Telegram bot at a time.
# It never reads or prints .env.
#
#   Usage:  bash deploy/launchd/setup-new-host.sh [--check-only]
#     --check-only   tool checks + the plist rendered into a temp file (linted, then deleted); no
#                    npm ci, no build, no ollama pull, nothing staged in the repo. Exit 1 if a
#                    required tool is missing or omp is not the pinned version.
#   EXTRA_PATH=/a:/b  extra dirs to put on the daemon's PATH (optional).
set -euo pipefail

CHECK_ONLY=0
case "${1:-}" in
  --check-only) CHECK_ONLY=1 ;;
  "") ;;
  *) echo "usage: bash deploy/launchd/setup-new-host.sh [--check-only]" >&2; exit 2 ;;
esac

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
echo "== Houge new-host setup$([ "$CHECK_ONLY" = 1 ] && echo " (check only)") =="
echo "project: $PROJECT_DIR"
echo "host:    $(scutil --get ComputerName 2>/dev/null || hostname)  user: $(whoami)"

# The omp version the daemon refuses to run without (src/omp/omp-config.ts HOUGE_OMP_VERSION default).
OMP_PIN="$(sed -n 's/^ *HOUGE_OMP_VERSION: "\([0-9][0-9.]*\)",.*/\1/p' "$PROJECT_DIR/src/omp/omp-config.ts")"
[ -n "$OMP_PIN" ] || { echo "cannot read the omp version pin from src/omp/omp-config.ts" >&2; exit 2; }

# 1. Toolchain. Required: the daemon cannot run its turns without them. Optional: one feature degrades.
#    omp's launcher is `#!/usr/bin/env bun`, so bun is required even though omp is spawned by absolute path.
echo; echo "-- prerequisites --"
missing=0
BIN_DIRS=""
tool_path() { command -v "$1" 2>/dev/null || true; }
check_tool() { # name required note
  local p; p="$(tool_path "$1")"
  if [ -n "$p" ]; then
    printf "  ok   %-7s %s\n" "$1" "$p"
  elif [ "$2" = 1 ]; then
    printf "  MISS %-7s required: %s\n" "$1" "$3"; missing=1
  else
    printf "  --   %-7s optional: %s\n" "$1" "$3"
  fi
}
check_tool git    1 "self-write branches and merges"
check_tool node   1 "runs the daemon"
check_tool npm    1 "build"
check_tool bun    1 "omp's launcher is #!/usr/bin/env bun"
check_tool omp    1 "the LLM runtime (planner and every one-shot seat), pinned $OMP_PIN"
check_tool codex  1 "self-diagnose and self-write"
check_tool agy    0 "voice notes; without it a voice message fails loudly"
check_tool ollama 0 "episodic embeddings; without it retrieval degrades to keyword (BM25) search"

OMP_PATH="$(tool_path omp)"
if [ -n "$OMP_PATH" ]; then
  omp_version="$("$OMP_PATH" --version 2>/dev/null | sed -n 's#.*omp/\([0-9][0-9.]*\).*#\1#p' | head -1 || true)"
  if [ "$omp_version" = "$OMP_PIN" ]; then
    echo "  ok   omp version $omp_version (pinned $OMP_PIN)"
  else
    echo "  BAD  omp version '${omp_version:-unreadable}' is not the pinned $OMP_PIN: every spawn would be refused"; missing=1
  fi
fi
[ "$missing" = 1 ] && echo "  !! fix the MISS/BAD lines before starting the daemon."

# 2. The daemon's PATH: launchd's is minimal. node runs the daemon; bun runs omp's launcher; codex and
#    agy are spawned too (their absolute paths still belong in .env). Order kept, duplicates dropped.
#    The template already ends the PATH with the system dirs, so those are left out here (no duplicates).
SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for t in node bun omp codex agy git; do
  p="$(tool_path "$t")"
  [ -n "$p" ] && BIN_DIRS="$BIN_DIRS$(dirname "$p")"$'\n'
done
DAEMON_PATH="$(printf '%s%s\n' "$BIN_DIRS" "$(printf '%s' "${EXTRA_PATH:-}" | tr ':' '\n')" \
  | awk -v sys="$SYSTEM_PATH" 'BEGIN { n = split(sys, s, ":"); for (i = 1; i <= n; i++) seen[s[i]] = 1 } NF && !seen[$0]++' \
  | tr '\n' ':' | sed 's/:$//')"

# A path goes into XML text (&, < and > escaped), through a sed replacement (\, & and the # delimiter
# escaped). A project dir may contain any of them.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
plist_value() { sed_escape "$(xml_escape "$1")"; }

render_plist() { # out
  sed -e "s#__PROJECT_DIR__#$(plist_value "$PROJECT_DIR")#g" \
      -e "s#__NODE_BIN_DIR__:#$(plist_value "${DAEMON_PATH:+$DAEMON_PATH:}")#g" \
      "$PROJECT_DIR/deploy/launchd/com.houge.daemon.plist.template" > "$1"
}

if [ "$CHECK_ONLY" = 1 ]; then
  PLIST_OUT="$(mktemp -t com.houge.daemon.plist)"
  trap 'rm -f "$PLIST_OUT"' EXIT
  render_plist "$PLIST_OUT"
  echo; echo "-- rendered the plist to a temp file (deleted on exit, not installed) --"
  if command -v plutil >/dev/null 2>&1; then
    if plutil -lint "$PLIST_OUT" >/dev/null; then echo "  plist lints OK"; else echo "  BAD  the rendered plist does not lint"; missing=1; fi
  fi
  echo "  PATH=$(plutil -extract EnvironmentVariables.PATH raw -o - "$PLIST_OUT" 2>/dev/null || echo '?')"
  echo "  WorkingDirectory=$(plutil -extract WorkingDirectory raw -o - "$PLIST_OUT" 2>/dev/null || echo '?')"
  exit "$missing"
fi
[ "$missing" = 1 ] && exit 1

# 3. Build.
echo; echo "-- build --"
npm ci
npm run build

# 4. Local embedding model (episodic memory) — best-effort.
if command -v ollama >/dev/null 2>&1; then
  echo; echo "-- ollama embeddinggemma (episodic) --"
  ollama pull embeddinggemma 2>&1 | tail -1 || echo "  (pull failed — episodic degrades to BM25 until available)"
fi

# 5. Generate the launchd plist from the template with THIS host's paths.
PLIST_OUT="$PROJECT_DIR/deploy/launchd/com.houge.daemon.plist"
render_plist "$PLIST_OUT"
mkdir -p "$PROJECT_DIR/logs"
echo; echo "-- generated $PLIST_OUT (PATH=${DAEMON_PATH:+$DAEMON_PATH:}$SYSTEM_PATH) --"

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

 C. Point .env at THIS host's binaries, by absolute path (launchd's PATH is restricted):
      HOUGE_OMP_BIN=$(tool_path omp)
      HOUGE_CODEX_BIN=$(tool_path codex)
      HOUGE_AGY_BIN=$(tool_path agy)
    and log omp in under the houge profile (deploy/launchd/README.md, Prerequisites).

 D. Install + start the service on THIS host:
      cp deploy/launchd/com.houge.daemon.plist ~/Library/LaunchAgents/
      launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.houge.daemon.plist

 E. Verify: tail -f logs/houge-daemon.err.log ; npm run houge -- status ;
    send a Telegram message; confirm houge.sqlite row counts match the old host.
=====================================================================
EOF
