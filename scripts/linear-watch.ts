#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest, LinearClient, type Issue } from "../linear/scripts/linear-client";
import { AgentCleanupError, createHerdrWorktree, herdrPing, makeHerdr, resolveRoleAgents, MAX_ACTIVE_AGENTS, STAGE_ROLES, type Herdr, type AgentSettings, type RoleAgents } from "../linear/scripts/agents";
import { runStages, type RunContext } from "../linear/scripts/stages";
import { acquireLock, git, resolveBaseBranch, STATE_ROOT, DEFAULT_HERDR_SOCKET } from "../linear/scripts/watcher-runtime";
import { runCreation } from "../linear/scripts/create-issues";
export { acquireLock, git, resolveBaseBranch, STATE_ROOT, DEFAULT_HERDR_SOCKET };

export const SCHEDULE = "0 */4 * * *";
const SUITE = resolve(import.meta.dir, "../linear");
export const DEFAULT_CONFIG = join(import.meta.dir, "config.json");
export const CREATE_SCHEDULE = "0 2 * * *";
export type Mode = "execute" | "create";

export type Route = {
  repo: string;
  team?: string;
  project?: string;
  todoState?: string;
  inProgressState?: string;
  doneState?: string;
  backlogState?: string;
  prompt?: string;
  baseBranch?: "main" | "master";
};
export type Config = AgentSettings & {
  routes: Route[];
  linearProfile?: string;
  linearBin?: string;
  herdrSocket?: string;
  stateDir?: string;
  timeoutMinutes?: number;
  maxActiveAgents?: number;
  creation?: { schedule?: string; maxIssuesPerRun?: number; maxBacklogIssues?: number };
};
export type Runtime = Config & {
  linearBin: string; codexBin: string; opencodeBin: string; stateDir: string; timeoutMinutes: number;
  maxActiveAgents: number; herdrSocket: string; herdr: Herdr; roleAgents: RoleAgents;
};
type Result = { issueId: string; outcome: "completed" | "blocked" | "failed"; baseBranch: string; commit: string | null; prUrl: string | null; validationCommentId: string | null; summary: string };

export async function loadConfig(path: string, overrides: Pick<Config, "linearBin" | "codexBin" | "opencodeBin"> = {}): Promise<Runtime> {
  const config: Config = { ...await Bun.file(path).json(), ...overrides };
  if (!Array.isArray(config.routes) || !config.routes.length) throw new Error("Config must contain at least one repository route");
  const stringKeys = ["model", "linearProfile", "linearBin", "codexBin", "opencodeBin", "herdrBin", "herdrSocket", "stateDir"] as const;
  for (const key of stringKeys) if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]!.trim())) throw new Error(`Invalid config.${key}`);
  const routes = config.routes.map((route) => {
    if (!route || typeof route.repo !== "string" || !route.repo.trim() || (!route.team && !route.project)) throw new Error("Every route needs repo and at least one of team / project");
    for (const key of ["team", "project", "todoState", "inProgressState", "doneState", "backlogState", "prompt"] as const) {
      if (route[key] !== undefined && (typeof route[key] !== "string" || !route[key]!.trim())) throw new Error(`Invalid route.${key}`);
    }
    if (route.baseBranch !== undefined && !["main", "master"].includes(route.baseBranch)) throw new Error("baseBranch must be main or master");
    if (route.repo.startsWith("~")) throw new Error("Use an absolute repo path or a path relative to the config file; ~ is not expanded in JSON");
    return { ...route, repo: resolve(dirname(path), route.repo) };
  });
  const timeoutMinutes = config.timeoutMinutes ?? 720;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  const maxActiveAgents = config.maxActiveAgents ?? MAX_ACTIVE_AGENTS;
  if (!Number.isInteger(maxActiveAgents) || maxActiveAgents < 1) throw new Error(`maxActiveAgents must be a positive integer (default ${MAX_ACTIVE_AGENTS})`);
  if (config.creation !== undefined) {
    if (!config.creation || typeof config.creation !== "object" || Array.isArray(config.creation)) throw new Error("creation must be an object");
    for (const key of Object.keys(config.creation)) if (!["schedule", "maxIssuesPerRun", "maxBacklogIssues"].includes(key)) throw new Error(`Unknown creation.${key}`);
    for (const key of ["maxIssuesPerRun", "maxBacklogIssues"] as const) {
      const value = config.creation[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`creation.${key} must be a positive integer`);
    }
    if (config.creation.schedule !== undefined) {
      const schedule = config.creation.schedule;
      if (typeof schedule !== "string" || schedule.trim().split(/\s+/).length !== 5) throw new Error("creation.schedule must be a five-field cron expression");
      if (typeof Bun.cron?.parse === "function" && !Bun.cron.parse(schedule)) throw new Error("Invalid creation.schedule");
    }
  }
  const binary = (name: string) => {
    const found = Bun.which(name);
    if (!found) throw new Error(`Executable not found: ${name}`);
    return found;
  };
  const herdrSocket = config.herdrSocket ? resolve(dirname(path), config.herdrSocket) : process.env.HERDR_SOCKET_PATH || DEFAULT_HERDR_SOCKET;
  return {
    ...config, routes, timeoutMinutes, maxActiveAgents, herdrSocket,
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

export async function verifyCompletion(client: LinearClient, issue: Issue, repo: string, base: string, branch: string, result: Result) {
  if (!result || result.issueId !== issue.id || result.baseBranch !== base) throw new Error("Agent result does not match the dispatched issue and base branch");
  if (result.outcome !== "completed") throw new Error(`Agent reported ${result.outcome}: ${result.summary}`);
  if (!result.commit || !/^[0-9a-f]{40,64}$/.test(result.commit) || !result.validationCommentId) throw new Error("Completed result is missing a commit or validation comment");
  if (!result.prUrl || !/^https?:\/\/\S+\/pull\/\d+$/.test(result.prUrl)) throw new Error("Completed result is missing a pull request URL");
  let remote = "";
  try { remote = await git(repo, "ls-remote", "origin", `refs/heads/${branch}`); }
  catch { throw new Error(`Could not read origin for ${repo}; the issue branch must be pushed for the pull request`); }
  if (remote.trim().split("\t")[0] !== result.commit) throw new Error(`Reported commit ${result.commit} was not pushed to origin/${branch}`);
  const saved = await client.issue(issue.id);
  if (saved.state.type !== "completed") throw new Error("Agent exited successfully but the Linear issue is not completed");
  const comment = (await client.comments(issue.id)).find((comment) => comment.id === result.validationCommentId);
  if (!comment?.body?.includes(result.commit)) throw new Error("Validation comment was not found on the issue or does not identify the verified commit");
  if (!(await client.comments(issue.id)).some((comment) => comment.body.includes(result.prUrl!))) throw new Error("Pull request link was not posted to the issue");
}

export async function runOnce(config: Runtime, options: { mode?: Mode; dryRun?: boolean; signal?: AbortSignal; singleIssue?: boolean } = {}) {
  if (options.mode === "create") return runCreation(config, options);
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
      if (options.dryRun) { summary.planned++; log("would-start", { issue: issue.identifier, repo, baseBranch, agents: config.roleAgents, stageRoles: STAGE_ROLES, maxActiveAgents: config.maxActiveAgents }); continue; }
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
        maxAgents: config.maxActiveAgents,
        env: { ...process.env, LINEAR_CLI_BIN: config.linearBin,
          ...(config.linearProfile ? { LINEAR_CLI_PROFILE: config.linearProfile } : {}) },
        onAgent: (role, stage, info) => {
          issueLock!.update({ herdrAgent: info.name, paneId: info.paneId, workspaceId: context.workspaceId, role, stage, runDir });
          repoLock!.update({ herdrAgent: info.name, paneId: info.paneId, workspaceId: context.workspaceId, role, stage, runDir });
        },
      });
      await Bun.write(join(runDir, "result.json"), JSON.stringify(result, null, 2));
      await verifyCompletion(client, fresh, repo, baseBranch, context.branch, result);
      await Bun.write(join(runDir, "verified.json"), JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2));
      // Keep the issue worktree, branch, and workspace for the user's review and manual cleanup.
      log("worktree-preserved", { issue: fresh.identifier, workspaceId: context.workspaceId, worktree: context.worktree, branch: context.branch });
      summary.completed++;
      log("completed", { issue: fresh.identifier, commit: result.commit, prUrl: result.prUrl, validationCommentId: result.validationCommentId, runDir });
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

export async function runScheduled(configPath: string, overrides: Pick<Config, "linearBin" | "codexBin" | "opencodeBin"> = {}, options: { mode?: Mode; singleIssue?: boolean } = {}) {
  const signals = signalController();
  try {
    const summary = await runOnce(await loadConfig(configPath, overrides), { ...options, signal: signals.signal });
    if (summary.failed || signals.signal.aborted) process.exitCode = 1;
  } finally { signals.dispose(); }
}

export function cronWorkerSource(configPath: string, config: Pick<Runtime, "linearBin" | "codexBin" | "opencodeBin">, mode: Mode = "execute") {
  return `import { runScheduled } from ${JSON.stringify(import.meta.path)};\nprocess.env.PATH = ${JSON.stringify(process.env.PATH ?? "")};\n${process.env.CODEX_HOME ? `process.env.CODEX_HOME = ${JSON.stringify(process.env.CODEX_HOME)};\n` : ""}export default { async scheduled() { await runScheduled(${JSON.stringify(configPath)}, ${JSON.stringify({ linearBin: config.linearBin, codexBin: config.codexBin, opencodeBin: config.opencodeBin })}, ${JSON.stringify({ mode })}); } };\n`;
}

export const cronTitle = (configPath: string, mode: Mode = "execute") => `${mode === "create" ? "linear-create" : "linear-watch"}-${digest(configPath)}`;

export async function main(args = Bun.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    config: { type: "string" }, mode: { type: "string" }, once: { type: "boolean" }, test: { type: "boolean" }, "dry-run": { type: "boolean" },
    install: { type: "boolean" }, uninstall: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`bun scripts/linear-watch.ts [--config CONFIG] [--mode execute|create] [--once | --test | --dry-run | --install | --uninstall]
Modes:
  execute (default): scan Todo issues now, then every four hours (${SCHEDULE}).
  create: explore repositories with agents.creator (Codex by default) and create Backlog issues.
          Scan now, then daily at ${CREATE_SCHEDULE}; creation.schedule overrides the schedule.
Run options:
  --once runs all eligible issues/repositories once.
  --test runs one eligible issue (execute) or repository (create), then exits even on dispatch failure.
  --dry-run reads Linear/Git and prints the resolved scope and agents without launching workers or writing logs.
  --install registers an OS cron job; --uninstall removes it. Each mode has its own job name.
Agents:
  defaults and agents.{orchestrator,planner,executor,creator} support agent, model, reasoningEffort and extraArgs.
  Planner owns analyze/plan/todos; executor owns implement/validate/pr; orchestrator directs development.
  Creator generates candidates; the script publishes Backlog issues and verifies their priority and dependencies.
  All agents run in Herdr worktree workspaces and dedicated panes. herdrBin/herdrSocket select the session.
  Socket default: HERDR_SOCKET_PATH or ${DEFAULT_HERDR_SOCKET}.
  maxActiveAgents (default ${MAX_ACTIVE_AGENTS}) limits live Herdr agents; capacity waits count toward timeoutMinutes.
Creation options:
  routes[].prompt, routes[].backlogState, creation.schedule, creation.maxIssuesPerRun (per repository), creation.maxBacklogIssues.
Config: --config, then LINEAR_WATCH_CONFIG, then ${DEFAULT_CONFIG}.
Examples: linear/linear-watch.example.json and scripts/config.codex.example.json.`);
    return;
  }
  if ([values.once, values.test, values["dry-run"], values.install, values.uninstall].filter(Boolean).length > 1) throw new Error("Choose only one run mode");
  const mode = values.mode ?? "execute";
  if (mode !== "execute" && mode !== "create") throw new Error("--mode must be execute or create");
  const configPath = resolve(values.config ?? process.env.LINEAR_WATCH_CONFIG ?? DEFAULT_CONFIG);
  const title = cronTitle(configPath, mode);
  if (values.uninstall) {
    if (typeof Bun.cron?.remove !== "function") throw new Error("This Bun version does not support Bun.cron.remove");
    await Bun.cron.remove(title); console.log(`Removed ${title}`); return;
  }
  const config = await loadConfig(configPath);
  const schedule = mode === "create" ? config.creation?.schedule ?? CREATE_SCHEDULE : SCHEDULE;
  if (values.install) {
    if (typeof Bun.cron !== "function") throw new Error("This Bun version does not support Bun.cron; upgrade Bun");
    for (const route of config.routes) await resolveBaseBranch(route.repo, route.baseBranch);
    await herdrPing(config.herdr);
    const jobPath = join(config.stateDir, "jobs", `${title}.ts`);
    mkdirSync(dirname(jobPath), { recursive: true });
    // OS cron starts with a minimal environment. Persist executable paths and PATH, never API tokens.
    writeFileSync(jobPath, cronWorkerSource(configPath, config, mode), { mode: 0o600 });
    await Bun.cron(jobPath, schedule, title);
    console.log(`Installed ${title}: ${schedule}\nConfig: ${configPath}\nLogs: ${config.stateDir}`);
    return;
  }
  if (values.once || values.test) return runScheduled(configPath, {}, { mode, singleIssue: values.test });
  if (values["dry-run"]) { const result = await runOnce(config, { mode, dryRun: true }); if (result.failed) process.exitCode = 1; return; }
  if (typeof Bun.cron !== "function") throw new Error("This Bun version does not support Bun.cron; upgrade Bun or use --once");
  const signals = signalController();
  let running = false;
  const tick = async () => {
    if (running || signals.signal.aborted) return;
    running = true;
    try { await runOnce(await loadConfig(configPath), { mode, signal: signals.signal }); }
    catch (error: any) { console.error(JSON.stringify({ event: "scan-failed", error: error.message })); }
    finally { running = false; }
  };
  const job = Bun.cron(schedule, tick);
  signals.signal.addEventListener("abort", () => { job.stop(); signals.dispose(); }, { once: true });
  console.log(`Watching ${mode} now and at ${schedule} (system timezone); config: ${configPath}`);
  await tick();
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
