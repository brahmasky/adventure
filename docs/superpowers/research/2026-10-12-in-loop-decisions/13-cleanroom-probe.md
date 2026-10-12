# Clean-room Seatbelt probe for standing approvals (2026-10-12)

Run by the round-4 senior spec review on the gate machine (Darwin 24.6.0, Intel, `/usr/bin/curl` 8.7.1). Scratch paths are shown as `<scratch>`; `<room>` and `<home>` are the fresh per-run directories.

## Profile used (profile-final.sb)

```scheme
(version 1)
(allow default)
(deny file-read*)
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (literal "/dev/null") (subpath "<room>") (subpath "<home>"))
(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp") (literal "<scratch>/cleanroom") (literal "<scratch>") (literal "<scratch-parent>/scratchpad") (literal "<scratch-parent>") (literal "<tmp-user-dir>") (literal "<tmp-uid>") (literal "/private/tmp") (literal "/private") (literal "/"))
(deny file-write*)
(allow file-write* (subpath "<room>") (literal "/dev/null"))
(deny signal (target others))
(deny process-exec (literal "/bin/launchctl"))
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.launchd"))
```

## Part 2: clean-room live probe (§8.3)

**Final working profile** (`cleanroom/profile-final.sb`; ROOM, HOME0 and ANCESTORS spelled out in the file):

```
(version 1)
(allow default)
(deny file-read*)
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library")
                  (subpath "/private/etc") (literal "/dev/null") (subpath ROOM) (subpath HOME0))
(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp") ANCESTORS-OF-ROOM...)
(deny file-write*)
(allow file-write* (subpath ROOM) (literal "/dev/null"))
(deny signal (target others))
(deny process-exec (literal "/bin/launchctl"))
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.launchd"))
```

Run as `env -i PATH=/usr/bin:/bin HOME=HOME0 CURL_HOME=HOME0 XDG_CONFIG_HOME=HOME0 TMPDIR=ROOM sandbox-exec -f … /bin/bash -c …`, with the process's cwd set to ROOM.

**What the spec's allowlist is missing (found by bisection):**

1. `(allow file-read-data (literal "/"))`. Without it, **every** binary aborts at dyld start (rc 134, even `/bin/echo`). `file-read-metadata` on `/` is not enough. This exposes only the names of the root directory's entries.
2. `file-read-metadata` on the **symlinks** `/etc` and `/var`. Without it, DNS fails silently (`curl: (6) Could not resolve host`), while an IP literal works. No data read under `/private/var` is needed. This exposes symlink metadata only.
3. `file-read-metadata` on each ancestor of the room, or bash prints `getcwd: cannot access parent directories`.
   Harmless, but it means the profile is rendered per room path.
4. The spec's reason for `/private/etc`, "for TLS roots" (spec:778), is wrong on this machine. `/usr/bin/curl` is
   SecureTransport: its trust roots come from `/System/Library/Keychains` plus trustd over Mach. `/private/etc` is
   needed for `hosts` and the resolver.
5. The `/usr/bin/python3` shim fails ("unable to read data link at /var/select/developer_dir") **and prints
   "requesting install"**: a GUI install prompt on the Mac mini from a sealed run. `/usr/bin/git` works.

None of 1–4 reopens a planted-file path. `/`, `/etc`, `/var` and the ancestors get metadata or a directory listing
only, and the shell and planner profiles can't write any of them (`writeRoots` = `$HOME`, `/private/tmp`, workspace;
`protected-paths.ts:48-50`). `/usr` includes `/usr/local`: Intel Homebrew, owned by xiaochuan, 647 binaries. It is
writable only by unsandboxed processes, not by either child profile, so it sits outside the planted-by-planner model.

**Results:**

- **(a) curl https:** PASS (200) once 1–2 are added; fails with `Could not resolve host` without 2.
  mDNSResponder needs no file allowance (it's reached over IPC under `allow default`). An explicit `(deny
  network-outbound (remote unix-socket))` breaks DNS unless `/private/var/run/mDNSResponder` is re-allowed by
  path-literal (tested).
- **(b) shell loop:** PASS. The bash `for` loop with `$(…)`, pipes, `<<<` (also with TMPDIR unset), `grep|sort|tr`, and `-c cj.txt` then `-b cj.txt` all work. zsh `for`/`$(…)` works too. No read of `/opt/homebrew`, `/private/var` or the dyld caches is needed (the dyld cache is under `/System`).
- **(c) `-H @/tmp/planted`:** BLOCKED. curl exits 2 ("error encountered when reading a file"). The unsandboxed control sent `X-Planted: yes`.
- **(d) symlink out of the room:** BLOCKED for reads (`cat`), directory traversal, writes through a symlinked dir, and hardlink creation. **But `curl -b <symlink-out>` and `-c <symlink-out>/cj.txt` fail silently with exit 0**: curl ignores an unreadable or unwritable jar.
- **(e) planted `~/.curlrc`:** IGNORED. This holds with HOME pointed at a dir outside the allowlist, with HOME unset (getpwuid fallback), and with a `.curlrc` in the cwd. **Honoured** when planted in the readable HOME0, so HOME0 must be fresh per run and unwritable by children. `-q` also ignores it. Real `~/.curlrc`, `~/.config/curlrc` and `~/.netrc` don't exist.

