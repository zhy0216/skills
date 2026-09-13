import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cronTitle, cronWorkerSource, git, loadConfig, runOnce, STATE_ROOT, type Config } from "../../scripts/linear-watch";
import { parseCreationResult, resolveCreationTarget, runCreation, type Candidate } from "../scripts/create-issues";
import { LinearClient, type Issue } from "../scripts/linear-client";

const temporary: string[] = [];
const previousEnv = { LINEAR_TEST_STATE: process.env.LINEAR_TEST_STATE, LINEAR_HERDR_STATE: process.env.LINEAR_HERDR_STATE };
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const root of temporary.splice(0)) {
    const runs = join(root, "logs/create/runs");
    if (existsSync(runs)) for (const name of readdirSync(runs)) {
      const manifest = join(runs, name, "manifest.json");
      if (existsSync(manifest)) rmSync(join(STATE_ROOT, "create/pending", `${JSON.parse(readFileSync(manifest, "utf8")).scope}.json`), { force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const team = { id: "team-id", key: "ENG", name: "Engineering" };
const states = [{ id: "backlog", name: "Backlog", type: "backlog" }, { id: "todo", name: "Todo", type: "unstarted" }, { id: "started", name: "In Progress", type: "started" }, { id: "done", name: "Done", type: "completed" }];
function candidate(key: string, extra: Partial<Candidate> = {}): Candidate {
  return { key, title: `Allow ${key}`, description: `## 用户问题\nUsers cannot ${key}.\n\n## 验收标准\n- [ ] Users can ${key}.\n\n## 优先级\nMedium: completes the workflow.`, priority: 3,
    blockedBy: [], evidence: [{ path: "base.txt", line: 1, reason: "The existing entry point lacks this capability" }], ...extra };
}
function issue(extra: Partial<Issue> = {}): Issue {
  return { id: crypto.randomUUID(), identifier: "ENG-1", title: "Existing requirement", description: "Existing acceptance", url: "https://linear.test/issue/ENG-1", priority: 2,
    archivedAt: null, state: states[0]!, team, project: null, createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", ...extra };
}

async function setup(extra: Record<string, any> = {}, withRepo = true) {
  const root = mkdtempSync(join(tmpdir(), "linear-create-test-")); temporary.push(root);
  const statePath = join(root, "state.json");
  process.env.LINEAR_TEST_STATE = statePath; process.env.LINEAR_HERDR_STATE = join(root, "herdr-state.json");
  await Bun.write(statePath, JSON.stringify({ issues: [], comments: [], documents: [], states, teams: [team], pageSize: 2, ...extra }));
  for (const name of ["linear-cli", "codex", "opencode", "herdr"]) {
    const fixture = await Bun.file(join(import.meta.dir, "fixtures", `${name === "opencode" ? "codex" : name}.ts`)).text();
    await Bun.write(join(root, name), fixture.replace("#!/usr/bin/env bun", `#!${process.execPath}`)); chmodSync(join(root, name), 0o755);
  }
  const repo = join(root, "repo");
  if (withRepo) {
    mkdirSync(repo); await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Creator test"); await git(repo, "config", "user.email", "creator@example.invalid");
    await Bun.write(join(repo, "base.txt"), "Existing product entry point\n"); await git(repo, "add", "base.txt"); await git(repo, "commit", "-m", "initial");
  }
  const configPath = join(root, "config.json");
  await Bun.write(configPath, JSON.stringify({ routes: [{ repo: "repo", team: "ENG", prompt: "Explore the core workflow" }], stateDir: "logs", linearBin: join(root, "linear-cli"), codexBin: join(root, "codex"), opencodeBin: join(root, "opencode"), herdrBin: join(root, "herdr"), herdrSocket: join(root, "herdr.sock") }));
  return { root, repo, statePath, configPath, client: new LinearClient(join(root, "linear-cli")),
    state: () => Bun.file(statePath).json(),
    calls: () => readFileSync(statePath + ".calls", "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    runs: () => readdirSync(join(root, "logs/create/runs")).map((name) => join(root, "logs/create/runs", name)),
    config: async (extra: Partial<Config> = {}) => { await Bun.write(configPath, JSON.stringify({ ...await Bun.file(configPath).json(), ...extra })); return loadConfig(configPath); },
  };
}

describe("creator candidates", () => {
  test("rejects missing evidence, invalid priorities, duplicate keys and cyclic dependencies before publishing", () => {
    const result = (candidates: Candidate[]) => ({ runId: "run", outcome: "completed", summary: "Explored", candidates });
    expect(parseCreationResult(result([]), "run").candidates).toEqual([]);
    for (const candidates of [
      [candidate("a", { evidence: [] })], [candidate("a", { priority: 0 })], [candidate("a"), candidate("a")],
      [candidate("a", { blockedBy: ["candidate:missing"] })],
      [candidate("a", { blockedBy: ["candidate:b"] }), candidate("b", { blockedBy: ["candidate:a"] })],
      [candidate("a", { evidence: [{ path: "../outside", line: 1, reason: "outside" }] })],
      [candidate("constructor")],
    ]) expect(() => parseCreationResult(result(candidates), "run")).toThrow();
    expect(() => parseCreationResult(result([candidate("a")]), "run", 0)).toThrow("more than 0");
    expect(() => parseCreationResult(result([]), "other")).toThrow("runId");
  });
});

describe("creation integration", () => {
  test("dry run resolves paginated targets without launching agents or writing run state", async () => {
    const s = await setup({ projects: [{ id: "project-id", name: "Web", teams: [team] }] });
    const config = await s.config({ routes: [{ repo: s.repo, project: "Web" }] });
    expect((await runOnce(config, { mode: "create", dryRun: true })).planned).toBe(1);
    expect(existsSync(join(s.root, "logs"))).toBe(false);
    expect(existsSync(join(s.root, "herdr-state.json"))).toBe(false);
    expect(s.calls().some((c) => c.args.includes("mutate"))).toBe(false);
  });

  test("creates Backlog issues in dependency order with one Codex creator and verified native relations", async () => {
    const first = candidate("foundation", { priority: 4, title: "Foundation with `code` and $(touch NOT_EXECUTED)" });
    const second = candidate("followup", { priority: 2, blockedBy: ["candidate:foundation"] });
    const s = await setup({ creatorCandidates: [second, first] });
    const before = await git(s.repo, "rev-parse", "HEAD");
    const config = await s.config({ defaults: { agent: "opencode", model: "provider/model", extraArgs: ["--agent", "build"] }, agents: { creator: { agent: "codex", model: "creator-model", reasoningEffort: "high" } } });
    const summary = await runCreation(config);
    expect(summary.failed).toBe(0); expect(summary.created).toBe(2);
    const state = await s.state();
    expect(state.issues.map((i: Issue) => i.title)).toEqual([first.title, second.title]);
    expect(state.issues.every((i: Issue) => i.state.id === "backlog" && i.state.type === "backlog" && i.team.id === team.id && i.priority > 0)).toBe(true);
    expect(state.relations).toHaveLength(1);
    expect(state.relations[0]).toMatchObject({ type: "blocks", issue: { id: state.issues[0].id }, relatedIssue: { id: state.issues[1].id } });
    expect(state.issues[1].description).toContain(state.issues[0].url);
    const run = s.runs()[0]!;
    const invocation = await Bun.file(join(run, "invocation.json")).json();
    expect(invocation.context.role).toBe("creator"); expect(invocation.context.prompt).toBe("Explore the core workflow");
    expect(invocation.args).toContain("creator-model"); expect(invocation.args).not.toContain("build");
    expect(readFileSync(join(run, "invocations.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(run, "verified.json"))).toBe(true);
    expect(await git(s.repo, "rev-parse", "HEAD")).toBe(before); expect(await git(s.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(s.repo, "NOT_EXECUTED"))).toBe(false);
    const herdr = await Bun.file(join(s.root, "herdr-state.json")).json();
    expect(Object.values(herdr.workspaces).every((w: any) => w.closed)).toBe(true);
    expect((await git(s.repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect((await runOnce(config, { dryRun: true })).planned).toBe(0);
  }, 15_000);

  test("skips existing and within-scan duplicate routes without changing existing issues", async () => {
    const existing = issue({ title: "Allow foundation", state: states[2]!, priority: 1 });
    const s = await setup({ issues: [existing], creatorCandidates: [candidate("foundation"), candidate("next", { blockedBy: [`issue:${existing.id}`] })] });
    const config = await s.config({ routes: [{ repo: s.repo, team: "ENG" }, { repo: s.repo, team: team.id }] });
    const summary = await runCreation(config);
    expect(summary.created).toBe(1); expect(summary.reused).toBe(1); expect(summary.skipped).toBe(1);
    expect((await s.state()).issues.find((i: Issue) => i.id === existing.id)).toEqual(existing);
    expect((await runCreation(config)).created).toBe(0);
    expect((await s.state()).issues).toHaveLength(2);
  }, 15_000);

  test("distinct candidate key prefixes remain distinct and analysis cleans up when launched on an older feature branch", async () => {
    const s = await setup({ creatorCandidates: [candidate("base-next"), candidate("base")] });
    await git(s.repo, "branch", "feature");
    await Bun.write(join(s.repo, "new.txt"), "New on main\n"); await git(s.repo, "add", "new.txt"); await git(s.repo, "commit", "-m", "Advance main");
    await git(s.repo, "switch", "feature");
    expect((await runCreation(await s.config())).created).toBe(2);
    expect(await git(s.repo, "branch", "--show-current")).toBe("feature");
    expect(await git(s.repo, "for-each-ref", "--format=%(refname)", "refs/heads/linear-create/")).toBe("");
  }, 10_000);

  test("a historical title alone does not override the creator's decision that a new requirement is needed", async () => {
    const s = await setup({ issues: [issue({ title: "Allow new", state: states[3]! })], creatorCandidates: [candidate("new")] });
    expect((await runCreation(await s.config())).created).toBe(1);
    expect((await s.state()).issues).toHaveLength(2);
  }, 10_000);

  test("an overlapping creator is skipped while the first run holds its lock and times out", async () => {
    const s = await setup({ hang: true });
    const config = await s.config({ timeoutMinutes: 0.02 });
    const first = runCreation(config);
    const deadline = Date.now() + 3000;
    while (!existsSync(join(s.root, "herdr-state.json")) && Date.now() < deadline) await Bun.sleep(10);
    const second = await runCreation(config);
    expect(second.skipped).toBe(1); expect((await first).failed).toBe(1);
    expect((await s.state()).issues).toHaveLength(0);
    expect(s.runs()).toHaveLength(1);
  }, 10_000);

  test("workload above 100 stops before reading the repository and Backlog does not count", async () => {
    const s = await setup({ pageSize: 50, issues: Array.from({ length: 101 }, (_, n) => issue({ identifier: `ENG-${n}`, state: states[1]! })) }, false);
    const summary = await runCreation(await s.config());
    expect(summary.skipped).toBe(1); expect(summary.failed).toBe(0);
    expect(existsSync(join(s.root, "herdr-state.json"))).toBe(false);
    const t = await setup({ pageSize: 50, issues: Array.from({ length: 101 }, (_, n) => issue({ identifier: `ENG-${n}` })) });
    expect((await runCreation(await t.config(), { dryRun: true })).planned).toBe(1);
  });

  test("Backlog capacity skips exploration and candidates must respect the configured limit", async () => {
    const s = await setup({ issues: [issue()], creatorCandidates: [candidate("a"), candidate("b")] });
    expect((await runCreation(await s.config({ creation: { maxBacklogIssues: 1 } }))).skipped).toBe(1);
    expect(existsSync(join(s.root, "herdr-state.json"))).toBe(false);
    expect((await runCreation(await s.config({ creation: { maxIssuesPerRun: 1 } }))).failed).toBe(1);
    expect((await s.state()).issues).toHaveLength(1);
  }, 10_000);

  for (const failure of ["loseCreateResponseOnce", "loseRelationResponseOnce", "partial"]) {
    test(`resumes ${failure} with saved IDs and no second agent or duplicate mutations`, async () => {
      const s = await setup({ creatorCandidates: [candidate("base"), candidate("next", { blockedBy: ["candidate:base"] })], ...(failure === "partial" ? { failCreateNumber: 2 } : { [failure]: true }) });
      const config = await s.config();
      const first = await runCreation(config);
      expect(first.failed).toBe(1);
      if (failure === "partial") expect(first.created).toBe(1);
      expect((await runCreation(config)).failed).toBe(0);
      const state = await s.state();
      expect(state.issues).toHaveLength(2); expect(new Set(state.issues.map((i: Issue) => i.id)).size).toBe(2);
      expect(state.relations).toHaveLength(1); expect(s.runs()).toHaveLength(1);
      expect(readFileSync(join(s.runs()[0]!, "invocations.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
      const creates = s.calls().filter((c) => c.operation === "LinearCreatorCreate");
      if (failure === "partial") expect(creates[1].variables.input.id).toBe(creates[2].variables.input.id);
      else expect(creates).toHaveLength(2);
    }, 15_000);
  }

  for (const extra of [{ creatorChangesRepo: true }, { wrongCreatorRun: true }, { wrongCreatedPriority: true }, { creatorCandidates: [candidate("broken", { evidence: [{ path: "missing.ts", line: 1, reason: "Missing evidence" }] })] }]) {
    test(`rejects invalid creator output or readback: ${Object.keys(extra)[0]}`, async () => {
      const s = await setup({ creatorCandidates: [candidate("new")], ...extra });
      expect((await runCreation(await s.config())).failed).toBe(1);
      expect(existsSync(join(s.runs()[0]!, "verified.json"))).toBe(false);
      if (!("wrongCreatedPriority" in extra)) expect((await s.state()).issues).toHaveLength(0);
    }, 10_000);
  }

  test("empty results succeed and --test creates for only one eligible repository", async () => {
    const s = await setup();
    const otherRepo = join(s.root, "other"); await git(s.repo, "clone", s.repo, otherRepo);
    await s.config({ routes: [{ repo: s.repo, team: "ENG" }, { repo: otherRepo, team: "ENG" }] });
    const output = await Bun.$`${process.execPath} ${resolve(import.meta.dir, "../../scripts/linear-watch.ts")} --config ${s.configPath} --mode create --test`.quiet();
    const summary = JSON.parse(output.text().trim().split("\n").at(-1)!);
    expect(summary.completed).toBe(1); expect(summary.created).toBe(0); expect(s.runs()).toHaveLength(1);
  }, 10_000);

  test("validates target ambiguity and creation config before launching a creator", async () => {
    const s = await setup({ projects: [{ id: "p", name: "Web", teams: [team, { id: "other", key: "API", name: "API" }] }] });
    await expect(resolveCreationTarget(s.client, { repo: s.repo, project: "Web" })).rejects.toThrow("2 matches");
    expect((await resolveCreationTarget(s.client, { repo: s.repo, project: "Web", team: "ENG" })).team.id).toBe(team.id);
    await expect(resolveCreationTarget(s.client, { repo: s.repo, team: "ENG", backlogState: "Todo" })).rejects.toThrow("Backlog state");
    for (const creation of [{ maxIssuesPerRun: 0 }, { maxBacklogIssues: -1 }, { schedule: "invalid" }]) await expect(s.config({ creation })).rejects.toThrow();
  });

  test("creation cron workers preserve mode and have a different title from existing execution jobs", async () => {
    const s = await setup({ creatorCandidates: [candidate("cron")] });
    const config = await s.config();
    expect(cronTitle(s.configPath, "create")).not.toBe(cronTitle(s.configPath));
    const worker = join(s.root, "worker.ts"); await Bun.write(worker, cronWorkerSource(s.configPath, config, "create"));
    const result = Bun.spawn([process.execPath, "run", "--cron-title=creator-test", "--cron-period=0 2 * * *", worker], { cwd: tmpdir(), env: process.env, stdout: "pipe", stderr: "pipe" });
    const [code, stderr, stdout] = await Promise.all([result.exited, new Response(result.stderr).text(), new Response(result.stdout).text()]);
    if (code !== 0) throw new Error(`Cron worker exited ${code}: ${stderr}\n${stdout}`);
    expect((await s.state()).issues).toHaveLength(1);
  }, 10_000);
});
