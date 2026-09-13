import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { command } from "./linear-client";

export const STATE_ROOT = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "linear-watch");
export const DEFAULT_HERDR_SOCKET = join(homedir(), ".config/herdr/herdr.sock");

export async function git(repo: string, ...args: string[]) {
  return command(["git", "-C", repo, ...args]);
}

export async function resolveBaseBranch(repo: string, configured?: "main" | "master"): Promise<"main" | "master"> {
  const branches = (await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/main", "refs/heads/master")).split("\n").filter(Boolean);
  if (configured) {
    if (!branches.includes(configured)) throw new Error(`Local base branch ${configured} does not exist in ${repo}`);
    return configured;
  }
  const current = await git(repo, "branch", "--show-current");
  if (current === "main" || current === "master") return current;
  if (branches.length === 1) return branches[0] as "main" | "master";
  // An explicit default ref is usable; guessing between two unrelated base branches is not.
  try {
    const remote = (await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
    if ((remote === "main" || remote === "master") && branches.includes(remote)) return remote;
  } catch { /* no origin/HEAD */ }
  throw new Error(`Cannot determine the original main/master base in ${repo}; set route.baseBranch`);
}

// Locks deliberately survive a hard crash. A stale lock is reported, never stolen while an orphaned agent may still be running.
export function acquireLock(path: string, context: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    return null;
  }
  const token = crypto.randomUUID();
  const owner = { token, pid: process.pid, createdAt: new Date().toISOString(), ...context };
  const ownerPath = join(path, "owner.json");
  writeFileSync(ownerPath, JSON.stringify(owner, null, 2), { mode: 0o600 });
  return {
    update(extra: Record<string, unknown>) { Object.assign(owner, extra); writeFileSync(ownerPath, JSON.stringify(owner, null, 2), { mode: 0o600 }); },
    release() {
      if (JSON.parse(readFileSync(ownerPath, "utf8")).token === token) rmSync(path, { recursive: true });
    },
  };
}
