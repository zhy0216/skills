#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { command, digest, LinearClient, type Issue } from "../linear/scripts/linear-client";
import { AgentCleanupError, closeHerdrWorkspace, createHerdrWorktree, herdrPing, makeHerdr, resolveRoleAgents, STAGE_ROLES, type Herdr, type AgentSettings, type RoleAgents } from "../linear/scripts/agents";
import { runStages, type RunContext } from "../linear/scripts/stages";

export const SCHEDULE = "0 */4 * * *";
const SUITE = resolve(import.meta.dir, "../linear");
const STATE_ROOT = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "linear-watch");
export const DEFAULT_CONFIG = join(import.meta.dir, "config.json");
export const DEFAULT_HERDR_SOCKET = join(homedir(), ".config/herdr/herdr.sock");

export type Route = {
  repo: string;
  team?: string;
  project?: string;
  todoState?: string;
  inProgressState?: string;
  doneState?: string;
  baseBranch?: "main" | "master";
};
export type Config = AgentSettings & {
  routes: Route[];
  linearProfile?: string;
  linearBin?: string;
  herdrSocket?: string;
  stateDir?: string;
  timeoutMinutes?: number;
};
type Runtime = Config & {
  linearBin: string; codexBin: string; opencodeBin: string; stateDir: string; timeoutMinutes: number;
  herdrSocket: string; herdr: Herdr; roleAgents: RoleAgents;
};
type Result = { issueId: string; outcome: "completed" | "blocked" | "failed"; baseBranch: string; commit: string | null; validationCommentId: string | null; summary: string };

export async function loadConfig(path: string, overrides: Pick<Config, "linearBin" | "codexBin" | "opencodeBin"> = {}): Promise<Runtime> {
  const config: Config = { ...await Bun.file(path).json(), ...overrides };
  if (!Array.isArray(config.routes) || !config.routes.length) throw new Error("Config must contain at least one repository route");
  const stringKeys = ["model", "linearProfile", "linearBin", "codexBin", "opencodeBin", "herdrBin", "herdrSocket", "stateDir"] as const;
  for (const key of stringKeys) if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]!.trim())) throw new Error(`Invalid config.${key}`);
  const routes = config.routes.map((route) => {
    if (!route || typeof route.repo !== "string" || !route.repo.trim() || (!route.team && !route.project)) throw new Error("Every route needs repo and at least one of team / project");
    for (const key of ["team", "project", "todoState", "inProgressState", "doneState"] as const) {
      if (route[key] !== undefined && (typeof route[key] !== "string" || !route[key]!.trim())) throw new Error(`Invalid route.${key}`);
    }
    if (route.baseBranch !== undefined && !["main", "master"].includes(route.baseBranch)) throw new Error("baseBranch must be main or master");
    if (route.repo.startsWith("~")) throw new Error("Use an absolute repo path or a path relative to the config file; ~ is not expanded in JSON");
    return { ...route, repo: resolve(dirname(path), route.repo) };
  });
  const timeoutMinutes = config.timeoutMinutes ?? 720;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  const binary = (name: string) => {
    const found = Bun.which(name);
    if (!found) throw new Error(`Executable not found: ${name}`);
    return found;
  };
  const herdrSocket = config.herdrSocket ? resolve(dirname(path), config.herdrSocket) : process.env.HERDR_SOCKET_PATH || DEFAULT_HERDR_SOCKET;
  return {
    ...config, routes, timeoutMinutes, herdrSocket,
    linearBin: binary(config.linearBin ?? "linear-cli"),
    codexBin: Bun.which(config.codexBin ?? "codex") ?? config.codexBin ?? "codex",
    opencodeBin: Bun.which(config.opencodeBin ?? "opencode") ?? config.opencodeBin ?? "opencode",
    herdr: makeHerdr(config.herdrBin, herdrSocket),
    roleAgents: resolveRoleAgents(config),
    stateDir: config.stateDir ? resolve(dirname(path), config.stateDir) : STATE_ROOT,
  };
}

const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export function matchesRoute(issue: Issue, route: Route) {
  return !issue.archivedAt && issue.state.type === "unstarted"
    && [issue.state.id, issue.state.name].some((value) => equal(value, route.todoState ?? "Todo"))
    && (!route.team || [issue.team.id, issue.team.key, issue.team.name].some((value) => equal(value, route.team!)))
    && (!route.project || !!issue.project && [issue.project.id, issue.project.name].some((value) => equal(value, route.project!)));
}

export async function git(repo: string, ...args: string[]) {
  return command(["git", "-C", repo, ...args]);
}

export async function resolveBaseBranch(repo: string, configured?: Route["baseBranch"]): Promise<"main" | "master"> {
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

export async function verifyCompletion(client: LinearClient, issue: Issue, repo: string, base: string, result: Result) {
  if (!result || result.issueId !== issue.id || result.baseBranch !== base) throw new Error("Agent result does not match the dispatched issue and base branch");
  if (result.outcome !== "completed") throw new Error(`Agent reported ${result.outcome}: ${result.summary}`);
  if (!result.commit || !/^[0-9a-f]{40,64}$/.test(result.commit) || !result.validationCommentId) throw new Error("Completed result is missing a commit or validation comment");
  try { await git(repo, "merge-base", "--is-ancestor", result.commit, `refs/heads/${base}`); }
  catch { throw new Error(`Reported commit ${result.commit} is not merged into ${base}`); }
  const saved = await client.issue(issue.id);
  if (saved.state.type !== "completed") throw new Error("Agent exited successfully but the Linear issue is not completed");
  const comment = (await client.comments(issue.id)).find((comment) => comment.id === result.validationCommentId);
  if (!comment?.body?.includes(result.commit)) throw new Error("Validation comment was not found on the issue or does not identify the merged commit");
}

export async function runOnce(config: Runtime, options: { dryRun?: boolean; signal?: AbortSignal; singleIssue?: boolean } = {}) {
  const client = new LinearClient(config.linearBin, config.linearProfile);
  const summary = { completed: 0, failed: 0, skipped: 0, planned: 0 };
  let pickedUp = false;
  const log = (event: string, detail: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...detail });
    console.log(line);
    if (!options.dryRun) {
      mkdirSync(config.stateDir, { recursive: true });
      appendFileSync(join(config.stateDir, "watcher.jsonl"), line + "\n", { mode: 0o600 });
    }
  };
  // Complete the snapshot before changing any status, otherwise cursor pagination can skip issues.
  const issues = [...new Map((await client.todoIssues()).map((issue) => [issue.id, issue])).values()]
    .sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.createdAt.localeCompare(b.createdAt) || a.identifier.localeCompare(b.identifier));
  for (const issue of issues) {
    if (options.signal?.aborted || (options.singleIssue && pickedUp)) break;
    const matches = config.routes.filter((route) => matchesRoute(issue, route));
    if (!matches.length) { summary.skipped++; continue; }
    if (matches.length > 1) { summary.failed++; log("ambiguous-route", { issue: issue.identifier }); continue; }
    const route = matches[0]!;
    let repoLock: ReturnType<typeof acquireLock> = null;
    let issueLock: ReturnType<typeof acquireLock> = null;
    let preserveLocks = false;
    let runDir: string | undefined;
    let herdrRun: { workspaceId: string; worktree: string; branch: string } | null = null;
    try {
      const repo = await git(route.repo, "rev-parse", "--show-toplevel");
      const commonDir = await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const baseBranch = await resolveBaseBranch(repo, route.baseBranch);
      if (options.dryRun) { summary.planned++; log("would-start", { issue: issue.identifier, repo, baseBranch, agents: config.roleAgents, stageRoles: STAGE_ROLES }); continue; }
      issueLock = acquireLock(join(STATE_ROOT, "locks", `issue-${digest(issue.id)}`), { issue: issue.identifier, repo });
      if (!issueLock) { summary.skipped++; log("issue-locked", { issue: issue.identifier, lock: join(STATE_ROOT, "locks", `issue-${digest(issue.id)}`) }); continue; }
      const repoLockPath = join(commonDir, "linear-watch.lock");
      repoLock = acquireLock(repoLockPath, { issue: issue.identifier, repo });
      if (!repoLock) { summary.skipped++; log("repo-locked", { issue: issue.identifier, lock: repoLockPath }); continue; }
      const fresh = await client.issue(issue.id);
      if (!matchesRoute(fresh, route)) { summary.skipped++; log("no-longer-todo", { issue: issue.identifier }); continue; }
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
      runDir = join(config.stateDir, "runs", `${fresh.identifier}-${runId}`);
      mkdirSync(runDir, { recursive: true });
      const baseSha = await git(repo, "rev-parse", `refs/heads/${baseBranch}`);
      // The Herdr workspace owns the issue worktree; each stage agent runs in its own pane there.
      const created = await createHerdrWorktree(config.herdr, repo, `linear/${fresh.identifier.toLowerCase()}-${runId}`, `refs/heads/${baseBranch}`, fresh.identifier);
      herdrRun = { workspaceId: created.workspaceId, worktree: created.worktree, branch: `linear/${fresh.identifier.toLowerCase()}-${runId}` };
      if (await git(created.worktree, "rev-parse", "HEAD") !== baseSha) throw new Error("Herdr worktree was not created at the recorded base commit");
      const context: RunContext = {
        runId, issueId: fresh.id, identifier: fresh.identifier, issueUrl: fresh.url, repo,
        baseBranch, baseSha, branch: herdrRun.branch, worktree: created.worktree, runDir,
        workspaceId: created.workspaceId, rootPane: created.rootPane,
        inProgressState: route.inProgressState, doneState: route.doneState,
        todoState: route.todoState ?? "Todo", linearProfile: config.linearProfile,
        skill: join(SUITE, "finish-linear-todo/SKILL.md"), helper: join(SUITE, "scripts/linear-issue.ts"),
      };
      await Bun.write(join(runDir, "context.json"), JSON.stringify({ ...context, roleAgents: config.roleAgents, stageRoles: STAGE_ROLES }, null, 2));
      log("start", { issue: fresh.identifier, repo, baseBranch, runDir, workspaceId: context.workspaceId, worktree: context.worktree });
      // Count the dispatch attempt, so a failed launch also ends a single-issue test run.
      pickedUp = true;
      const result = await runStages(context, config.roleAgents, {
        herdr: config.herdr, client, timeoutMs: config.timeoutMinutes * 60_000, signal: options.signal, log,
        env: { ...process.env, LINEAR_CLI_BIN: config.linearBin,
          ...(config.linearProfile ? { LINEAR_CLI_PROFILE: config.linearProfile } : {}) },
        onAgent: (role, stage, info) => {
          issueLock!.update({ herdrAgent: info.name, paneId: info.paneId, workspaceId: context.workspaceId, role, stage, runDir });
          repoLock!.update({ herdrAgent: info.name, paneId: info.paneId, workspaceId: context.workspaceId, role, stage, runDir });
        },
      });
      await Bun.write(join(runDir, "result.json"), JSON.stringify(result, null, 2));
      await verifyCompletion(client, fresh, repo, baseBranch, result);
      await Bun.write(join(runDir, "verified.json"), JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2));
      try {
        await closeHerdrWorkspace(config.herdr, context.workspaceId);
        await git(repo, "worktree", "remove", context.worktree);
        await git(repo, "branch", "-d", context.branch);
        log("worktree-cleaned", { issue: fresh.identifier, worktree: context.worktree, branch: context.branch });
      } catch (error: any) {
        log("cleanup-failed", { issue: fresh.identifier, workspaceId: context.workspaceId, worktree: context.worktree, branch: context.branch, error: error.message });
      }
      summary.completed++;
      log("completed", { issue: fresh.identifier, commit: result.commit, validationCommentId: result.validationCommentId, runDir });
    } catch (error: any) {
      if (error instanceof AgentCleanupError) preserveLocks = true;
      summary.failed++;
      log("failed", { issue: issue.identifier, error: error.message, runDir, ...(herdrRun ? { preserved: herdrRun } : {}) });
      if (runDir) await Bun.write(join(runDir, "failure.json"), JSON.stringify({ error: error.message, at: new Date().toISOString() }));
    } finally {
      if (!preserveLocks) { repoLock?.release(); issueLock?.release(); }
    }
  }
  log("scan-complete", summary);
  return summary;
}

function signalController() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return { signal: controller.signal, dispose() { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); } };
}

export async function runScheduled(configPath: string, overrides: Pick<Config, "linearBin" | "codexBin" | "opencodeBin"> = {}, options: { singleIssue?: boolean } = {}) {
  const signals = signalController();
  try {
    const summary = await runOnce(await loadConfig(configPath, overrides), { ...options, signal: signals.signal });
    if (summary.failed || signals.signal.aborted) process.exitCode = 1;
  } finally { signals.dispose(); }
}

export function cronWorkerSource(configPath: string, config: Pick<Runtime, "linearBin" | "codexBin" | "opencodeBin">) {
  return `import { runScheduled } from ${JSON.stringify(import.meta.path)};\nprocess.env.PATH = ${JSON.stringify(process.env.PATH ?? "")};\n${process.env.CODEX_HOME ? `process.env.CODEX_HOME = ${JSON.stringify(process.env.CODEX_HOME)};\n` : ""}export default { async scheduled() { await runScheduled(${JSON.stringify(configPath)}, ${JSON.stringify({ linearBin: config.linearBin, codexBin: config.codexBin, opencodeBin: config.opencodeBin })}); } };\n`;
}

export async function main(args = Bun.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    config: { type: "string" }, once: { type: "boolean" }, test: { type: "boolean" }, "dry-run": { type: "boolean" },
    install: { type: "boolean" }, uninstall: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`bun scripts/linear-watch.ts [--config CONFIG] [--once | --test | --dry-run | --install | --uninstall]\nDefault: scan now, then Bun.cron('${SCHEDULE}') in the foreground.\n--test processes at most one eligible Todo through the configured stages, then exits even on failure.\n--dry-run reads Linear/Git and shows resolved role configs and stage ownership; --install registers an OS cron job.\nAgent config: defaults and agents.{orchestrator,planner,executor} support agent, model, reasoningEffort, extraArgs.\nPlanner owns analyze/plan/todos; executor owns implement/validate/merge; orchestrator directs the workflow.\nAll roles run inside Herdr: each issue gets a worktree workspace via 'herdr worktree create' and each stage an agent in its own pane. herdrBin selects the CLI; herdrSocket selects the session socket (default: HERDR_SOCKET_PATH or ${DEFAULT_HERDR_SOCKET}).\nConfig format: linear/linear-watch.example.json. Default config: ${DEFAULT_CONFIG}`);
    return;
  }
  if ([values.once, values.test, values["dry-run"], values.install, values.uninstall].filter(Boolean).length > 1) throw new Error("Choose only one run mode");
  const configPath = resolve(values.config ?? process.env.LINEAR_WATCH_CONFIG ?? DEFAULT_CONFIG);
  const title = `linear-watch-${digest(configPath)}`;
  if (values.uninstall) {
    if (typeof Bun.cron?.remove !== "function") throw new Error("This Bun version does not support Bun.cron.remove");
    await Bun.cron.remove(title); console.log(`Removed ${title}`); return;
  }
  const config = await loadConfig(configPath);
  if (values.install) {
    if (typeof Bun.cron !== "function") throw new Error("This Bun version does not support Bun.cron; upgrade Bun");
    for (const route of config.routes) await resolveBaseBranch(route.repo, route.baseBranch);
    await herdrPing(config.herdr);
    const jobPath = join(config.stateDir, "jobs", `${title}.ts`);
    mkdirSync(dirname(jobPath), { recursive: true });
    // OS cron starts with a minimal environment. Persist executable paths and PATH, never API tokens.
    writeFileSync(jobPath, cronWorkerSource(configPath, config), { mode: 0o600 });
    await Bun.cron(jobPath, SCHEDULE, title);
    console.log(`Installed ${title}: ${SCHEDULE}\nConfig: ${configPath}\nLogs: ${config.stateDir}`);
    return;
  }
  if (values.once || values.test) return runScheduled(configPath, {}, { singleIssue: values.test });
  if (values["dry-run"]) { const result = await runOnce(config, { dryRun: true }); if (result.failed) process.exitCode = 1; return; }
  if (typeof Bun.cron !== "function") throw new Error("This Bun version does not support Bun.cron; upgrade Bun or use --once");
  const signals = signalController();
  let running = false;
  const tick = async () => {
    if (running || signals.signal.aborted) return;
    running = true;
    try { await runOnce(await loadConfig(configPath), { signal: signals.signal }); }
    catch (error: any) { console.error(JSON.stringify({ event: "scan-failed", error: error.message })); }
    finally { running = false; }
  };
  const job = Bun.cron(SCHEDULE, tick);
  signals.signal.addEventListener("abort", () => { job.stop(); signals.dispose(); }, { once: true });
  console.log(`Watching now and at ${SCHEDULE} (system timezone); config: ${configPath}`);
  await tick();
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
