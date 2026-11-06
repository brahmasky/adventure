// The main checkout, found from git rather than written into the scripts (the repo is public, and a home path names one
// machine). From a worktree under `.worktrees/`, git's common dir is the main checkout's `.git`; from the main checkout
// it is its own `.git`. Gates read the main checkout's `houge.kill` and default base worktrees from it.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const commonDir = execFileSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();

export const MAIN_CHECKOUT = dirname(commonDir);
