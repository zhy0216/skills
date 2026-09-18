import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, LinearClient, type Issue } from "../scripts/linear-client";
import { countActiveAgents, makeHerdr, MAX_ACTIVE_AGENTS } from "../scripts/agents";
import { publishComment, publishPlan, publishTodos, replaceTodoSection, TODO_HEADING, transition } from "../scripts/linear-issue";
import { acquireLock, cronWorkerSource, git, loadConfig, matchesRoute, resolveBaseBranch, runOnce, SCHEDULE, type Config } from "../../scripts/linear-watch";

const temporary: string[] = [];
const previousEnv = process.env.LINEAR_TEST_STATE;
afterEach(() => {
  if (previousEnv === undefined) delete process.env.LINEAR_TEST_STATE; else process.env.LINEAR_TEST_STATE = previousEnv;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: crypto.randomUUID(), identifier: "ENG-1", title: "A title with `backticks` and $(touch NOT_EXECUTED)",
    url: "https://linear.test/issue/ENG-1", description: "Original requirement\n\n- [ ] Existing acceptance", updatedAt: "2026-09-08T00:00:00Z", createdAt: "2026-09-08T00:00:00Z",
    priority: 2, archivedAt: null, state: { id: "todo", name: "Todo", type: "unstarted" },
    team: { id: "team-id", key: "ENG", name: "Engineering" }, project: null, ...overrides,
  };
}

async function setup(issues = [makeIssue()], extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "linear-skills-test-"));
  temporary.push(root);
  const statePath = join(root, "state.json");
  process.env.LINEAR_TEST_STATE = statePath;
  process.env.LINEAR_HERDR_STATE = join(root, "herdr-state.json");
  await Bun.write(statePath, JSON.stringify({ issues, documents: [], comments: [], ...extra }));
  for (const name of ["linear-cli", "codex", "opencode", "herdr"]) {
    const fixture = await Bun.file(join(import.meta.dir, "fixtures", `${name === "opencode" ? "codex" : name}.ts`)).text();
    await Bun.write(join(root, name), fixture.replace("#!/usr/bin/env bun", `#!${process.execPath}`));
    chmodSync(join(root, name), 0o755);
  }
  const configPath = join(root, "config.json");
  await Bun.write(configPath, JSON.stringify({ routes: [{ repo: "repo", team: "ENG" }], stateDir: "logs", linearBin: join(root, "linear-cli"), codexBin: join(root, "codex"), opencodeBin: join(root, "opencode"), herdrBin: join(root, "herdr"), herdrSocket: join(root, "herdr.sock") }));
  return {
    root, statePath, configPath, issues, client: new LinearClient(join(root, "linear-cli")),
    state: () => Bun.file(statePath).json(),
    herdrState: () => Bun.file(join(root, "herdr-state.json")).json(),
    calls: () => readFileSync(statePath + ".calls", "utf8").trim().split("\n").map((s) => JSON.parse(s)),
    config: async (overrides: Partial<Config> = {}) => {
      if (Object.keys(overrides).length) await Bun.write(configPath, JSON.stringify({ ...await Bun.file(configPath).json(), ...overrides }));
      return loadConfig(configPath);
    },
  };
}

async function initRepo(root: string, branch: "main" | "master" = "main") {
  const repo = join(root, "repo"); mkdirSync(repo);
  const origin = join(root, "origin.git"); mkdirSync(origin);
  await git(origin, "init", "--bare", "-b", branch);
  await git(repo, "init", "-b", branch);
  await git(repo, "config", "user.name", "Linear test"); await git(repo, "config", "user.email", "linear-test@example.invalid");
  await Bun.write(join(repo, "base.txt"), "base\n"); await git(repo, "add", "base.txt"); await git(repo, "commit", "-m", "initial");
  await git(repo, "remote", "add", "origin", origin);
  return repo;
}

async function remoteHead(repo: string, branch: string) {
  return (await git(repo, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0];
}

function runPath(root: string) {
  const runs = readdirSync(join(root, "logs/runs"));
  expect(runs).toHaveLength(1);
  return join(root, "logs/runs", runs[0]!);
}

function allInvocations(root: string) {
  return readFileSync(join(runPath(root), "invocations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function invocations(root: string) {
  return allInvocations(root).filter((run) => run.context.role !== "orchestrator");
}

describe("Linear content and API", () => {
  test("paginates without a result cap and fails on repeated cursors", async () => {
    const s = await setup([makeIssue(), makeIssue({ identifier: "ENG-2" }), makeIssue({ identifier: "ENG-3" })]);
    expect((await s.client.todoIssues()).map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    const state = await s.state(); state.stuckCursor = true; await Bun.write(s.statePath, JSON.stringify(state));
    await expect(s.client.todoIssues()).rejects.toThrow("pagination did not advance");
  });

  test("rejects GraphQL errors even with CLI exit code zero", async () => {
    const s = await setup(undefined, { errorsOn: "LinearWatchTodos" });
    await expect(s.client.todoIssues()).rejects.toThrow("simulated GraphQL failure");
  });

  test("creates one native issue document and updates it without a project", async () => {
    const s = await setup();
    const content = "# Plan\n\nPreserve literal `code` and $(touch NOT_EXECUTED)\n";
    const first = await publishPlan(s.client, s.issues[0]!, content);
    const second = await publishPlan(s.client, s.issues[0]!, content + "\nMore detail");
    const state = await s.state();
    expect(first.id).toBe(second.id); expect(state.documents).toHaveLength(1);
    expect(state.documents[0].issueId).toBe(s.issues[0]!.id);
    expect(state.documents[0].content).toBe(content + "\nMore detail");
    expect(existsSync(join(s.root, "NOT_EXECUTED"))).toBe(false);
  });

  test("preserves original description and later human sections during task updates", async () => {
    const original = "# Problem\nUser content.\n\n## Acceptance\n- [ ] Keep me";
    const first = replaceTodoSection(original, "- [ ] T01 — First step", "https://linear.test/doc");
    const second = replaceTodoSection(first + "\n## Human notes\nKeep this too\n", "- [x] T01 — First step", "https://linear.test/doc");
    expect(second.startsWith(original + "\n\n")).toBe(true);
    expect(second).toContain("## Human notes\nKeep this too\n");
    expect(second.match(/Implementation tasks \(linear-auto-dev\)/g)).toHaveLength(1);
    expect(second).toContain("- [x] T01");
    expect(() => replaceTodoSection(`${TODO_HEADING}\n\n${TODO_HEADING}`, "- [ ] A", "url")).toThrow("Duplicate");
  });

  test("publishes tasks and rejects an observed concurrent description edit", async () => {
    const s = await setup();
    const plan = await publishPlan(s.client, s.issues[0]!, "Plan");
    await publishTodos(s.client, s.issues[0]!.id, "- [ ] T01 — First", plan.url);
    expect((await s.state()).issues[0].description).toContain("Existing acceptance");
    const state = await s.state(); state.reads = {}; state.editOnSecondRead = true; await Bun.write(s.statePath, JSON.stringify(state));
    await expect(publishTodos(s.client, s.issues[0]!.id, "- [x] T01 — First", plan.url)).rejects.toThrow("Issue changed");
    expect((await s.state()).issues[0].description).toContain("Human edit");
    expect((await s.state()).issues[0].description).toContain("- [ ] T01");
  });

  test("preserves example headings inside fenced code when replacing the managed section", () => {
    const original = `## Original requirement\n\n\`\`\`markdown\n${TODO_HEADING}\nExample only\n\`\`\`\n`;
    const withTasks = replaceTodoSection(original, "- [ ] T01 — Actual task", "https://linear.test/doc");
    const updated = replaceTodoSection(withTasks, "- [x] T01 — Actual task\n\n\`\`\`sh\n# command example\n\`\`\`", "https://linear.test/doc");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("- [x] T01 — Actual task");
  });

  test("uses team state IDs and does not guess between multiple started states", async () => {
    const s = await setup(undefined, { states: [
      { id: "a", name: "Coding", type: "started" }, { id: "b", name: "Review", type: "started" },
      { id: "c", name: "Shipped", type: "completed" },
    ] });
    await expect(transition(s.client, s.issues[0]!.id, "started")).rejects.toThrow("Cannot uniquely resolve");
    expect((await transition(s.client, s.issues[0]!.id, "started", "Coding")).state.id).toBe("a");
    expect((await transition(s.client, s.issues[0]!.id, "completed")).state.id).toBe("c");
  });

  test("uploads real bytes with signed headers and reuses the same comment key", async () => {
    let uploads = 0;
    let bytes = "";
    let signedHeader = "";
    const server = Bun.serve({ port: 0, async fetch(request) {
      uploads++; bytes = await request.text(); signedHeader = request.headers.get("x-upload-test") ?? "";
      return new Response("ok");
    } });
    try {
      const s = await setup(undefined, { uploadUrl: server.url.href });
      const artifact = join(s.root, "test.log"); await Bun.write(artifact, "2 tests passed\n");
      const first = await publishComment(s.client, s.issues[0]!.id, "# Validation\nAll passed", "run-123", [artifact]);
      const second = await publishComment(s.client, s.issues[0]!.id, "# Validation\nAll passed", "run-123", [artifact]);
      expect(first.id).toBe(second.id); expect(uploads).toBe(1); expect(bytes).toBe("2 tests passed\n"); expect(signedHeader).toBe("required");
      expect((await s.state()).comments[0].body).toContain("https://uploads.linear.test/artifact");
      expect((await s.state()).comments).toHaveLength(1);
    } finally { server.stop(true); }
  });

  test("does not publish a validation comment if artifact upload fails", async () => {
    const server = Bun.serve({ port: 0, fetch() { return new Response("failed", { status: 503 }); } });
    try {
      const s = await setup(undefined, { uploadUrl: server.url.href });
      const artifact = join(s.root, "test.log"); await Bun.write(artifact, "log");
      await expect(publishComment(s.client, s.issues[0]!.id, "Validation", "run-123", [artifact])).rejects.toThrow("503");
      expect((await s.state()).comments).toHaveLength(0);
    } finally { server.stop(true); }
  });
});

describe("watcher and Git integration", () => {
  test("matches exact Todo and explicit repository scope", () => {
    const issue = makeIssue(); const route = { repo: "/repo", team: "ENG" };
    expect(matchesRoute(issue, route)).toBe(true);
    expect(matchesRoute({ ...issue, state: { id: "ready", name: "Ready", type: "unstarted" } }, route)).toBe(false);
    expect(matchesRoute({ ...issue, state: { id: "backlog", name: "Backlog", type: "backlog" } }, route)).toBe(false);
    expect(matchesRoute(issue, { ...route, project: "Another project" })).toBe(false);
    expect(matchesRoute({ ...issue, archivedAt: "2026-01-01" }, route)).toBe(false);
  });

  test("uses the current main/master even when both exist and rejects an ambiguous feature base", async () => {
    const s = await setup(); const repo = await initRepo(s.root, "master"); await git(repo, "branch", "main");
    expect(await resolveBaseBranch(repo)).toBe("master");
    await git(repo, "switch", "-c", "feature");
    await expect(resolveBaseBranch(repo)).rejects.toThrow("Cannot determine");
    expect(await resolveBaseBranch(repo, "main")).toBe("main");
  });

  test("does not steal a lock, and allows acquisition only after its owner releases it", async () => {
    const s = await setup(); const path = join(s.root, "repo.lock");
    const first = acquireLock(path, { childPid: 99999999 }); expect(first).not.toBeNull();
    expect(acquireLock(path, {})).toBeNull();
    first!.release(); const next = acquireLock(path, {}); expect(next).not.toBeNull(); next!.release();
  });

  test("dry run reads all pages without launching Codex or writing logs", async () => {
    const s = await setup([makeIssue(), makeIssue({ identifier: "ENG-2" })]); await initRepo(s.root);
    const result = await runOnce(await s.config(), { dryRun: true });
    expect(result.planned).toBe(2); expect(existsSync(join(s.root, "logs"))).toBe(false);
    expect((await s.state()).issues.every((i: Issue) => i.state.name === "Todo")).toBe(true);
    expect(s.calls().every((call) => !call.args.includes("mutate"))).toBe(true);
  });

  test("--test picks one eligible issue by priority and exits after completing it", async () => {
    const changed = makeIssue({ identifier: "ENG-1", priority: 1 });
    const later = makeIssue({ identifier: "ENG-2", priority: 4 });
    const picked = makeIssue({ identifier: "ENG-3", priority: 2 });
    const s = await setup([changed, later, picked], { changeBeforeClaim: changed.id }); await initRepo(s.root);
    const output = await command([process.execPath, resolve(import.meta.dir, "../../scripts/linear-watch.ts"), "--config", s.configPath, "--test"], { timeoutMs: 5_000 });
    const summary = JSON.parse(output.split("\n").at(-1)!);
    expect(summary.completed).toBe(1); expect(summary.skipped).toBe(1); expect(summary.failed).toBe(0);
    const state = await s.state();
    expect(state.issues.find((issue: Issue) => issue.id === picked.id).state.type).toBe("completed");
    expect(state.issues.find((issue: Issue) => issue.id === later.id).state.name).toBe("Todo");
    expect(readdirSync(join(s.root, "logs/runs"))).toHaveLength(1);
  }, 10_000);

  test("--test stops after a failed dispatch without picking up a second issue", async () => {
    const first = makeIssue(); const later = makeIssue({ identifier: "ENG-2", priority: 3 });
    const s = await setup([first, later], { failIssues: [first.id] }); await initRepo(s.root);
    await expect(command([process.execPath, resolve(import.meta.dir, "../../scripts/linear-watch.ts"), "--config", s.configPath, "--test"], { timeoutMs: 5_000 })).rejects.toThrow("exited 1");
    const runs = readdirSync(join(s.root, "logs/runs"));
    expect(runs).toHaveLength(1);
    const invocation = await Bun.file(join(s.root, "logs/runs", runs[0]!, "invocation.json")).json();
    expect(invocation.context.issueId).toBe(first.id);
    expect((await s.state()).issues.find((issue: Issue) => issue.id === later.id).state.name).toBe("Todo");
  }, 10_000);

  for (const base of ["main", "master"] as const) {
    test(`dispatches YOLO/xhigh, publishes validation, and verifies a real pull request into ${base}`, async () => {
      const s = await setup(); const repo = await initRepo(s.root, base);
      const result = await runOnce(await s.config());
      expect(result).toEqual({ completed: 1, failed: 0, skipped: 0, planned: 0 });
      const run = join(s.root, "logs/runs", readdirSync(join(s.root, "logs/runs"))[0]!);
      const invocation = await Bun.file(join(run, "invocation.json")).json();
      expect(invocation.args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(invocation.args).toContain('model_reasoning_effort="xhigh"');
      expect(invocation.prompt).toContain("$finish-linear-todo");
      expect(invocation.context.baseBranch).toBe(base);
      const verified = await Bun.file(join(run, "verified.json")).json();
      expect(verified.prUrl).toMatch(/\/pull\/\d+$/);
      expect(await remoteHead(repo, invocation.context.branch)).toBe(verified.commit);
      // The local base branch is never merged or pushed by the PR flow.
      expect(await git(repo, "rev-list", "--count", base)).toBe("1");
      expect((await s.state()).issues[0].state.type).toBe("completed");
      expect((await s.state()).comments[0].body).toContain(verified.commit);
      expect((await s.state()).comments.some((comment: any) => comment.body.includes(verified.prUrl))).toBe(true);
      expect(existsSync(join(repo, ".git/linear-watch.lock"))).toBe(false);
      expect(existsSync(invocation.context.worktree)).toBe(false);
      expect(await git(repo, "branch", "--list", invocation.context.branch)).toBe("");
      const herdr = await s.herdrState();
      expect(Object.keys(herdr.workspaces).length).toBeGreaterThan(0);
      expect(Object.values(herdr.workspaces).every((w: any) => w.closed)).toBe(true);
      expect(Object.values(herdr.panes).every((p: any) => !p.alive)).toBe(true);
    }, 15_000);
  }

  test("rechecks status just before dispatch and skips an issue already claimed", async () => {
    const issue = makeIssue(); const s = await setup([issue], { changeBeforeClaim: issue.id }); await initRepo(s.root);
    const result = await runOnce(await s.config());
    expect(result.skipped).toBe(1); expect(result.completed).toBe(0);
    expect(existsSync(join(s.root, "logs/runs"))).toBe(false);
  });

  test("continues with the next issue after a Codex failure", async () => {
    const first = makeIssue(); const second = makeIssue({ identifier: "ENG-2", priority: 3 });
    const s = await setup([first, second], { failIssues: [first.id] }); await initRepo(s.root);
    const result = await runOnce(await s.config());
    expect(result.failed).toBe(1); expect(result.completed).toBe(1);
    expect((await s.state()).issues[0].state.name).toBe("Todo");
    expect((await s.state()).issues[1].state.type).toBe("completed");
  }, 15_000);

  test("does not accept exit zero with no structured result", async () => {
    const s = await setup(undefined, { noResult: true }); await initRepo(s.root);
    const result = await runOnce(await s.config()); expect(result.failed).toBe(1); expect(result.completed).toBe(0);
  });

  test("rejects a claimed completion when the issue branch was never pushed", async () => {
    const s = await setup(undefined, { falseComplete: true }); const repo = await initRepo(s.root);
    const before = await git(repo, "rev-parse", "HEAD"); const result = await runOnce(await s.config());
    expect(result.failed).toBe(1); expect(result.completed).toBe(0); expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
  }, 15_000);

  test("times out a stuck child and releases the repository lock", async () => {
    const s = await setup(undefined, { hang: true }); const repo = await initRepo(s.root);
    const config = await s.config(); config.timeoutMinutes = 0.005;
    const result = await runOnce(config);
    expect(result.failed).toBe(1); expect(existsSync(join(repo, ".git/linear-watch.lock"))).toBe(false);
  }, 5_000);

  test("a second scan cannot launch the same issue while its worker is active", async () => {
    const s = await setup(undefined, { hang: true }); await initRepo(s.root);
    const config = await s.config(); const abort = new AbortController();
    const active = runOnce(config, { signal: abort.signal });
    try {
      const runs = join(s.root, "logs/runs");
      const deadline = Date.now() + 3_000;
      while (!(existsSync(runs) && readdirSync(runs).some((run) => existsSync(join(runs, run, "waiting"))))) {
        if (Date.now() > deadline) throw new Error("Fixture did not start");
        await Bun.sleep(10);
      }
      const second = await runOnce(config);
      expect(second.skipped).toBe(1); expect(second.completed).toBe(0);
      expect(readdirSync(runs)).toHaveLength(1);
    } finally { abort.abort(); await active; }
  }, 5_000);

  test("maxActiveAgents defaults to 8 and only accepts positive integers", async () => {
    const s = await setup();
    expect((await s.config()).maxActiveAgents).toBe(MAX_ACTIVE_AGENTS);
    expect((await s.config({ maxActiveAgents: 3 })).maxActiveAgents).toBe(3);
    await expect(s.config({ maxActiveAgents: 0 })).rejects.toThrow("maxActiveAgents");
    await expect(s.config({ maxActiveAgents: 2.5 })).rejects.toThrow("maxActiveAgents");
  });

  test("counts only non-done agents reported by herdr agent list", async () => {
    const s = await setup();
    await Bun.write(join(s.root, "herdr-state.json"), JSON.stringify({
      seq: 2,
      workspaces: { x0: { label: "external", closed: false } },
      panes: { "x0:p1": { workspace: "x0", cwd: s.root, env: {}, alive: true }, "x0:p2": { workspace: "x0", cwd: s.root, env: {}, alive: true } },
      agents: {
        ext1: { pane: "x0:p1", kind: "codex", args: [], alive: true, prompts: 0 },
        ext2: { pane: "x0:p2", kind: "opencode", args: [], alive: true, prompts: 0, status: "done" },
      },
    }));
    expect(await countActiveAgents(makeHerdr(join(s.root, "herdr"), join(s.root, "herdr.sock")))).toBe(1);
  });

  test("waits for Herdr agent capacity before dispatching a stage, then proceeds when slots free up", async () => {
    const s = await setup(); const repo = await initRepo(s.root);
    const herdrPath = join(s.root, "herdr-state.json");
    await Bun.write(herdrPath, JSON.stringify({
      seq: 2,
      workspaces: { x0: { label: "external", closed: false } },
      panes: { "x0:p1": { workspace: "x0", cwd: repo, env: {}, alive: true }, "x0:p2": { workspace: "x0", cwd: repo, env: {}, alive: true } },
      agents: {
        ext1: { pane: "x0:p1", kind: "codex", args: [], alive: true, prompts: 0 },
        ext2: { pane: "x0:p2", kind: "opencode", args: [], alive: true, prompts: 0 },
      },
    }));
    const config = await s.config({ maxActiveAgents: 2 });
    const logsPath = join(s.root, "logs/watcher.jsonl");
    const readEvents = () => existsSync(logsPath) ? readFileSync(logsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    const run = runOnce(config);
    const free = async () => {
      const busy = await Bun.file(herdrPath).json();
      for (const pane of ["x0:p1", "x0:p2"]) busy.panes[pane].alive = false;
      await Bun.write(herdrPath, JSON.stringify(busy));
    };
    let failure: unknown;
    try {
      const deadline = Date.now() + 5_000;
      while (!readEvents().some((event) => event.event === "agent-capacity-wait")) {
        if (Date.now() > deadline) throw new Error("Watcher never reported waiting for agent capacity");
        await Bun.sleep(25);
      }
      expect((await s.state()).issues[0].state.name).toBe("Todo");
      expect(existsSync(join(s.root, "logs/runs"))).toBe(true);
    } catch (error) { failure = error; }
    await free();
    const result = await run;
    if (failure) throw failure;
    expect(result.completed).toBe(1);
    const waits = readEvents().filter((event) => event.event === "agent-capacity-wait");
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[0].active).toBe(2); expect(waits[0].max).toBe(2); expect(waits[0].agent).toMatch(/^lin-eng-1-/);
  }, 15_000);

  test("OS cron worker resolves its config and executables from an unrelated working directory", async () => {
    const s = await setup(); await initRepo(s.root);
    const config = await s.config({ defaults: { agent: "opencode" }, codexBin: join(s.root, "missing-codex") });
    const worker = join(s.root, "worker.ts");
    await Bun.write(worker, cronWorkerSource(s.configPath, config));
    await command([process.execPath, "run", "--cron-title=linear-test", `--cron-period=${SCHEDULE}`, worker], { cwd: tmpdir() });
    expect((await s.state()).issues[0].state.type).toBe("completed");
    expect(readdirSync(join(s.root, "logs/runs"))).toHaveLength(1);
    expect(invocations(s.root).every((run) => run.context.agentConfig.agent === "opencode")).toBe(true);
  }, 15_000);

  test("refuses overlapping routes", async () => {
    const s = await setup(); await initRepo(s.root); const config = await s.config(); config.routes.push({ ...config.routes[0]! });
    const result = await runOnce(config); expect(result.failed).toBe(1); expect(result.completed).toBe(0);
    expect(existsSync(join(s.root, "logs/runs"))).toBe(false);
  });

  test("native cron expression fires every four hours", () => {
    const start = new Date("2026-09-08T00:00:00Z");
    const first = Bun.cron.parse(SCHEDULE, start, { tz: "UTC" })!;
    const second = Bun.cron.parse(SCHEDULE, first, { tz: "UTC" })!;
    expect(first.toISOString()).toBe("2026-09-08T04:00:00.000Z");
    expect(second.getTime() - first.getTime()).toBe(4 * 60 * 60 * 1000);
  });
});

describe("role agent integration", () => {
  test("orchestrator can report a dependency blocker before the planner claims the issue", async () => {
    const s = await setup(undefined, { orchestratorBlock: "Upstream dependency is unfinished" }); const repo = await initRepo(s.root);
    const base = await git(repo, "rev-parse", "HEAD");
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(invocations(s.root)).toHaveLength(0);
    expect(allInvocations(s.root)[0].context.role).toBe("orchestrator");
    expect((await s.state()).issues[0].state.name).toBe("Todo");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(base);
    const preserved = allInvocations(s.root)[0].context;
    expect(existsSync(preserved.worktree)).toBe(true);
    expect(Object.values((await s.herdrState()).workspaces).every((w: any) => !w.closed)).toBe(true);
    expect((await Bun.file(join(runPath(s.root), "failure.json")).json()).error).toContain("Upstream dependency");
  });

  for (const invalid of ["orchestratorSkipToPr", "orchestratorPrematureComplete"]) {
    test(`rejects ${invalid} without running an executor or changing the issue`, async () => {
      const s = await setup(undefined, { [invalid]: true }); const repo = await initRepo(s.root);
      const before = await git(repo, "rev-parse", "HEAD");
      const result = await runOnce(await s.config());
      expect(result.failed).toBe(1); expect(result.completed).toBe(0);
      expect(invocations(s.root)).toHaveLength(0);
      expect((await s.state()).issues[0].state.name).toBe("Todo");
      expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    });
  }

  test("an independent orchestrator directs the planner and executor with each role's configured CLI", async () => {
    const s = await setup(undefined, { complex: true }); const repo = await initRepo(s.root);
    const literalTitle = "Planning `literal text` $(touch NOT_EXECUTED)";
    const config = await s.config({
      defaults: { agent: "codex", model: "test-default", reasoningEffort: "high", extraArgs: ["--profile", "test-profile"] },
      agents: {
        orchestrator: { model: "test-coordinator", reasoningEffort: "low" },
        planner: { agent: "opencode", model: "test/planner", reasoningEffort: "high", extraArgs: ["--title", literalTitle] },
        executor: { model: "test-executor", reasoningEffort: "xhigh", extraArgs: [] },
      },
    });
    expect(await runOnce(config)).toEqual({ completed: 1, failed: 0, skipped: 0, planned: 0 });
    const calls = invocations(s.root);
    expect(calls.map((run) => run.context.stage)).toEqual(["analyze", "plan", "todos", "implement", "validate", "pr"]);
    expect(calls.map((run) => run.context.role)).toEqual(["planner", "planner", "planner", "executor", "executor", "executor"]);
    expect(calls.map((run) => run.context.agentConfig.agent)).toEqual(["opencode", "opencode", "opencode", "codex", "codex", "codex"]);
    expect(calls.map((run) => run.args[run.args.indexOf("--model") + 1])).toEqual(["test/planner", "test/planner", "test/planner", "test-executor", "test-executor", "test-executor"]);
    for (const call of calls.slice(0, 3)) {
      expect(call.args).toContain("--auto");
      expect(call.args[call.args.indexOf("--title") + 1]).toBe(literalTitle);
      expect(call.args[call.args.indexOf("--variant") + 1]).toBe("high");
      expect(call.args).not.toContain("--profile");
    }
    for (const call of calls.slice(3)) {
      expect(call.args).toContain('model_reasoning_effort="xhigh"');
      expect(call.args).not.toContain("--profile");
    }
    const coordinatorCalls = allInvocations(s.root).filter((run) => run.context.role === "orchestrator");
    expect(coordinatorCalls).toHaveLength(7);
    expect(coordinatorCalls.every((run) => run.args.includes("test-coordinator") && run.args.includes('model_reasoning_effort="low"') && run.args.includes("test-profile"))).toBe(true);
    expect(coordinatorCalls.at(-1).context.canComplete).toBe(true);
    for (const call of calls) {
      expect(call.context.orchestratorInstructions).toContain(`Coordinator instruction for ${call.context.stage}`);
      expect(call.prompt).toContain(call.context.orchestratorInstructions);
    }
    const worktree = calls[0].context.worktree;
    expect(calls.every((run) => run.cwd === worktree)).toBe(true);
    expect(allInvocations(s.root).every((run) => run.cwd === worktree)).toBe(true);
    expect(existsSync(join(worktree, "NOT_EXECUTED"))).toBe(false);
    expect(calls[2].context.previousResults.plan.planDocumentId).toBe((await s.state()).documents[0].id);
    expect(calls[5].context.previousResults.validate.validationCommentId).toBe((await s.state()).comments[0].id);
    const context = await Bun.file(join(runPath(s.root), "context.json")).json();
    expect(context.stageHistory).toHaveLength(6);
    expect(context.roleAgents.executor.model).toBe("test-executor");
    expect(context.orchestrationHistory).toHaveLength(7);
    const state = await s.state();
    expect(state.documents[0].issueId).toBe(s.issues[0]!.id);
    expect(state.issues[0].description).toContain("Existing acceptance");
    expect(state.issues[0].description).toContain("- [x] T01");
    expect(await remoteHead(repo, context.branch)).toBe(context.stageResults.validate.commit);
  }, 15_000);

  test("simple issues skip plan/todos and use the planner only for analysis", async () => {
    const s = await setup(); await initRepo(s.root);
    const config = await s.config({ opencodeBin: join(s.root, "missing-opencode"), agents: { planner: { reasoningEffort: "high" } } });
    expect((await runOnce(config)).completed).toBe(1);
    expect(invocations(s.root).map((run) => run.context.stage)).toEqual(["analyze", "implement", "validate", "pr"]);
    expect(invocations(s.root).filter((run) => run.context.role === "planner")).toHaveLength(1);
    expect((await s.state()).documents).toHaveLength(0);
  }, 10_000);

  test("OpenCode-only runs need no Codex binary and recover a missing result file via one nudge", async () => {
    const s = await setup(undefined, { opencodeEventsOnly: true }); await initRepo(s.root);
    const config = await s.config({ defaults: { agent: "opencode" }, codexBin: join(s.root, "missing-codex") });
    expect((await runOnce(config)).completed).toBe(1);
    for (const call of invocations(s.root)) {
      expect(call.args).toContain("--auto");
      expect(call.args).not.toContain("--variant");
      expect((await Bun.file(call.context.stageResultPath).json()).stage).toBe(call.context.stage);
    }
    expect(allInvocations(s.root).filter((run) => run.context.role === "orchestrator")).toHaveLength(5);
  }, 10_000);

  for (const stage of ["implement", "validate"] as const) {
    test(`${stage} failure keeps the worktree and prevents a pull request`, async () => {
      const s = await setup(undefined, { failStage: stage }); const repo = await initRepo(s.root);
      const base = await git(repo, "rev-parse", "HEAD");
      const result = await runOnce(await s.config({ agents: { executor: { agent: "opencode" } } }));
      expect(result.failed).toBe(1); expect(result.completed).toBe(0);
      const calls = invocations(s.root);
      expect(calls.at(-1).context.stage).toBe(stage);
      expect(calls.some((run) => run.context.stage === "pr")).toBe(false);
      expect(existsSync(calls[0].context.worktree)).toBe(true);
      expect((await s.state()).issues[0].state.type).toBe("started");
      expect(await git(repo, "rev-parse", "HEAD")).toBe(base);
      expect(existsSync(join(repo, ".git/linear-watch.lock"))).toBe(false);
    }, 10_000);
  }

  test("requires an actual issue Document before starting todos", async () => {
    const s = await setup(undefined, { complex: true, missingPlanDocument: true }); await initRepo(s.root);
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(invocations(s.root).map((run) => run.context.stage)).toEqual(["analyze", "plan"]);
    expect((await s.state()).documents).toHaveLength(0);
  }, 10_000);

  test("an existing user checkbox does not replace the todos stage's checklist", async () => {
    const s = await setup(undefined, { complex: true, missingTasks: true }); await initRepo(s.root);
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(invocations(s.root).map((run) => run.context.stage)).toEqual(["analyze", "plan", "todos"]);
    expect((await s.state()).issues[0].description).toContain("- [ ] Existing acceptance");
  }, 10_000);

  test("requires a real validation comment before starting pr", async () => {
    const s = await setup(undefined, { missingValidationComment: true }); const repo = await initRepo(s.root);
    const before = await git(repo, "rev-parse", "HEAD");
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(invocations(s.root).at(-1).context.stage).toBe("validate");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect((await s.state()).issues[0].state.type).toBe("started");
  }, 10_000);

  for (const [timing, flag] of [["after validation", "advanceBaseOnce"], ["during pr", "advanceBaseAtPr"], ["during orchestrator review", "advanceBaseDuringReview"]]) {
    test(`base changes ${timing} return validation and pull request to the executor`, async () => {
      const s = await setup(undefined, { [flag!]: true }); const repo = await initRepo(s.root);
      const config = await s.config({
        agents: { orchestrator: { reasoningEffort: "low" }, executor: { agent: "opencode", model: "test/executor", reasoningEffort: "high" } },
      });
      expect((await runOnce(config)).completed).toBe(1);
      const calls = invocations(s.root);
      const validations = calls.filter((run) => run.context.stage === "validate");
      expect(validations).toHaveLength(2);
      expect(validations.every((run) => run.context.agentConfig.agent === "opencode" && run.args.includes("test/executor") && run.args.includes("--variant"))).toBe(true);
      const prs = calls.filter((run) => run.context.stage === "pr");
      expect(prs).toHaveLength(flag === "advanceBaseAtPr" ? 2 : 1);
      expect(prs.every((run) => run.context.role === "executor" && run.args.includes("test/executor") && run.args.includes("--variant"))).toBe(true);
      expect(prs.at(-1).context.previousResults.validate.commit).toBe(await remoteHead(repo, prs.at(-1).context.branch));
      expect((await s.state()).comments).toHaveLength(3);
      expect(await Bun.file(join(repo, "advanced.txt")).exists()).toBe(true);
      const context = await Bun.file(join(runPath(s.root), "context.json")).json();
      expect(context.stageHistory.filter((item: any) => item.stage === "validate").map((item: any) => item.attempt)).toEqual([1, 2]);
    }, 15_000);
  }

  test("rechecks the issue commit after orchestration before dispatching pr", async () => {
    const s = await setup(undefined, { changeWorktreeDuringReview: true }); const repo = await initRepo(s.root);
    const before = await git(repo, "rev-parse", "HEAD");
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(invocations(s.root).at(-1).context.stage).toBe("validate");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect((await s.state()).issues[0].state.type).toBe("started");
  }, 10_000);

  test("stops after three changing-base validations and preserves the unfinished issue", async () => {
    const s = await setup(undefined, { alwaysAdvanceBase: true }); const repo = await initRepo(s.root);
    const result = await runOnce(await s.config());
    expect(result.failed).toBe(1); expect(result.completed).toBe(0);
    const calls = invocations(s.root);
    expect(calls.filter((run) => run.context.stage === "validate")).toHaveLength(3);
    expect(calls.some((run) => run.context.stage === "pr")).toBe(false);
    expect((await s.state()).issues[0].state.type).toBe("started");
    expect(existsSync(calls[0].context.worktree)).toBe(true);
    expect(existsSync(join(repo, "ENG-1.txt"))).toBe(false);
  }, 15_000);

  test("orchestrator-requested rework invalidates the old validation before executor opens the pull request", async () => {
    const s = await setup(undefined, { orchestratorReworkOnce: true }); const repo = await initRepo(s.root);
    const config = await s.config({ agents: { executor: { agent: "opencode", model: "test/executor" } } });
    expect((await runOnce(config)).completed).toBe(1);
    const calls = invocations(s.root);
    expect(calls.map((run) => run.context.stage)).toEqual(["analyze", "implement", "validate", "implement", "validate", "pr"]);
    expect(calls[3].context.previousResults.validate).toBeUndefined();
    expect(calls[3].context.previousResults.implement).toBeUndefined();
    const context = await Bun.file(join(runPath(s.root), "context.json")).json();
    const validations = context.stageHistory.filter((item: any) => item.stage === "validate");
    expect(validations[0].result.commit).not.toBe(validations[1].result.commit);
    expect(context.stageResults.pr.commit).toBe(validations[1].result.commit);
    expect(await remoteHead(repo, context.branch)).toBe(validations[1].result.commit);
    expect((await s.state()).comments).toHaveLength(3);
  }, 15_000);

  test("orchestrator can return to the planner and reuse the native issue Document", async () => {
    const s = await setup(undefined, { complex: true, orchestratorReplanOnce: true }); await initRepo(s.root);
    const config = await s.config({ agents: { planner: { agent: "opencode" } } });
    expect((await runOnce(config)).completed).toBe(1);
    const calls = invocations(s.root);
    expect(calls.map((run) => run.context.stage)).toEqual(["analyze", "plan", "todos", "implement", "plan", "todos", "implement", "validate", "pr"]);
    expect(calls[4].context.role).toBe("planner");
    expect(calls[4].context.previousResults.implement).toBeUndefined();
    const state = await s.state();
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].content).toContain("Revision 2");
    expect(state.issues[0].description).toContain("Existing acceptance");
    expect(state.issues[0].description).toContain("- [x] T01");
  }, 15_000);

  test("bounds repeated orchestration and preserves the issue for recovery", async () => {
    const s = await setup(undefined, { orchestratorLoop: true }); const repo = await initRepo(s.root);
    const before = await git(repo, "rev-parse", "HEAD");
    expect((await runOnce(await s.config())).failed).toBe(1);
    expect(allInvocations(s.root).filter((run) => run.context.role === "orchestrator")).toHaveLength(24);
    expect(invocations(s.root).some((run) => run.context.role === "executor")).toBe(false);
    expect((await s.state()).issues[0].state.type).toBe("started");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect((await Bun.file(join(runPath(s.root), "failure.json")).json()).error).toContain("exceeded 24 decisions");
  }, 20_000);
});
