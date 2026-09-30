#!/bin/bash
# Houge shell wrapper (spec §5.6 R2–R5). Invoked by the daemon as the DETACHED process-group
# leader, OUTSIDE the sandbox:   /bin/bash shell-wrapper.sh <command>      (fd 3 = status pipe)
# Env: SB = Seatbelt profile path; HOUGE_SHELL_SANDBOX = 0 disables sandbox-exec (tests only).
# -u is per-user on macOS: cap = current user process count + 256 (bounded by the hard limit), computed unsandboxed. Any failure is fail-closed.
lf() { echo limits_failed >&3; exit 97; }
pl=$(ps -u "$(id -u)" -o pid= 2>/dev/null) || lf
n=$(printf '%s\n' "$pl" | grep -c .); [ "${n:-0}" -gt 0 ] 2>/dev/null || lf
lim=$((n + 256)); hard=$(ulimit -H -u) || lf
if [ "$hard" != "unlimited" ] && [ "$lim" -gt "$hard" ]; then lim=$hard; fi
ulimit -u "$lim" -t 600 -f 1048576 -n 1024 || lf
if [ "${HOUGE_SHELL_SANDBOX:-1}" = "0" ]; then
  /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
else
  sandbox-exec -f "$SB" /usr/bin/nice -n 10 /bin/bash -c "$1" 3>&-; rc=$?
fi
for i in $(seq 1 50); do
  m=$(pgrep -g $$); prc=$?
  if [ $prc -gt 1 ]; then echo cleanup_failed >&3; exit $rc; fi
  m=$(printf '%s\n' "$m" | grep -vx "$$" | grep -v '^$')
  if [ -z "$m" ]; then echo ok >&3; exit $rc; fi
  for p in $m; do kill -KILL "$p" 2>/dev/null; done
  sleep 0.1
done
echo cleanup_failed >&3; exit $rc
