import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { verifiedWorkspace } from "../omp/workspace.js";

/**
 * attach.path's send predicate (spec R7 §4.2, Decision 4-A; ADR 0034 4.1): the send-time re-check of one `[[attach:]]` file, moved verbatim
 * from the Telegram adapter into this protected leaf. omp turn attachments (spec §7): at most 5 files, each at most 20 MB.
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export type AttachmentRefusal =
  | "outside_workspace" | "not_a_file" | "too_large" | "over_count" | "unreadable" | "send_failed" | "unsupported" | "linked" | "changed"
  | "workspace_unverified" | "not_found";
/** What a check can answer: every refusal but `send_failed` (an upload that failed after the check passed). */
export type CheckRefusal = Exclude<AttachmentRefusal, "send_failed">;
/** One observed send-time check (spec R7 §4.2): closed enums, never a path. */
export type AttachCheck = "ok" | CheckRefusal;
/** Paco's words per refusal. The R7 split reasons reuse today's text, so every line he reads is byte-identical. */
export const REFUSAL_TEXT: Readonly<Record<AttachmentRefusal, string>> = {
  outside_workspace: "outside my workspace", not_a_file: "not a regular file", too_large: "over 20 MB",
  over_count: "more than 5 files", unreadable: "could not be read", send_failed: "Telegram refused the upload", unsupported: "this chat cannot take files",
  linked: "a hard-linked file", changed: "it changed while I was sending it",
  workspace_unverified: "outside my workspace", not_found: "could not be read"
};

/** The one containment helper (spec R7 §4.1): `p` strictly inside `root`. */
export function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The count cap, today's `i >= MAX_ATTACHMENTS`: true for every path past the fifth. */
export function overCount(i: number): boolean { return i >= MAX_ATTACHMENTS; }

export interface CheckDeps {
  /** The client can upload a document (today's `client.sendDocument` truthiness). */
  canUpload: boolean;
  /** The chat's configured workspace (unverified), resolved lazily: called only after canUpload, as today; undefined → every file is refused. */
  workspace: () => string | undefined;
  /** @internal Tests only: runs between opening the file and re-checking its path (simulates a swap in that window). */
  beforeRecheck?: (path: string) => void;
}

/**
 * Open once, then prove the open file is the one the path names inside the workspace: fstat the fd (regular, ≤ 20 MB, a single link),
 * re-resolve the path and require the same dev+ino with the realpath inside the workspace, then read exactly the checked size from that fd.
 * A swap anywhere in the path between the open and the read can only make the check fail, never redirect the upload.
 */
export function checkAttachment(path: string, deps: CheckDeps): CheckRefusal | { bytes: Uint8Array } {
  if (!deps.canUpload) return "unsupported";
  const configured = deps.workspace();
  const workspace = configured ? verifiedWorkspace(configured) : null; // a swapped workspace is no workspace (C2)
  if (!workspace) return "workspace_unverified";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); // a FIFO must never block the daemon's only thread
    const st = fstatSync(fd);
    if (!st.isFile()) return "not_a_file";
    if (st.size > MAX_ATTACHMENT_BYTES) return "too_large";
    if (st.nlink > 1) return "linked";
    deps.beforeRecheck?.(path);
    const real = realpathSync(path);
    if (!inside(workspace, real)) return "outside_workspace";
    const again = statSync(real);
    if (again.dev !== st.dev || again.ino !== st.ino) return "changed";
    return { bytes: readExactly(fd, st.size) };
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "not_found" : "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read exactly `size` bytes from the start of `fd` (a short read means the file changed: refuse). */
function readExactly(fd: number, size: number): Uint8Array {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) throw new Error("short read");
    off += n;
  }
  return buf;
}
