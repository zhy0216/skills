#!/usr/bin/env bun
import { join } from "node:path";
import { appendFileSync } from "node:fs";

const context = await Bun.file(process.env.LINEAR_WATCH_CONTEXT!).json();
const kind = context.agentConfig.agent;
const resultPath = kind === "codex" ? Bun.argv[Bun.argv.indexOf("--output-last-message") + 1]! : context.stageResultPath;
const prompt = await new Response(Bun.stdin.stream()).text();
const invocation = { args: Bun.argv.slice(2), prompt, context, cwd: process.cwd() };
await Bun.write(join(context.stageDir, "invocation.json"), JSON.stringify(invocation));
appendFileSync(join(context.runDir, "invocations.jsonl"), JSON.stringify(invocation) + "\n");
if (context.stage === "analyze" || !(await Bun.file(join(context.runDir, "invocation.json")).exists())) await Bun.write(join(context.runDir, "invocation.json"), JSON.stringify(invocation));
const statePath = process.env.LINEAR_TEST_STATE!;
const initial = await Bun.file(statePath).json();
if (initial.failIssues?.includes(context.issueId)) { console.error("simulated Codex failure"); process.exit(7); }
if (initial.hang) { await Bun.write(join(context.runDir, "waiting"), "yes"); await Bun.sleep(60_000); }
if (initial.noResult) process.exit(0);
if (initial.failStage === context.stage) { console.error(`simulated ${context.stage} failure`); process.exit(8); }

function run(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", env: process.env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const git = (repo: string, ...args: string[]) => run(["git", "-C", repo, ...args]);
const helper = (...args: string[]) => JSON.parse(run([process.execPath, context.helper, ...args]));
async function emitResult(result: Record<string, any>) {
  if (!(kind === "opencode" && initial.opencodeEventsOnly)) await Bun.write(resultPath, JSON.stringify(result));
  if (kind === "opencode") {
    console.log(JSON.stringify({ type: "text", part: { text: "Work finished." } }));
    console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(result) } }));
    if (initial.opencodeErrorEvent) console.log(JSON.stringify({ type: "error", error: { message: "simulated stream error" } }));
  }
}
if (context.role === "orchestrator") {
  let nextStage = context.suggestedStage;
  const last = context.stageHistory.at(-1);
  if (initial.advanceBaseDuringReview && last?.stage === "validate" && last.attempt === 1 && nextStage === "merge") {
    await Bun.write(join(context.repo, "advanced.txt"), "advanced during orchestrator review");
    git(context.repo, "add", "advanced.txt"); git(context.repo, "commit", "-m", "Advance base during review");
  }
  if (initial.changeWorktreeDuringReview && nextStage === "merge") {
    await Bun.write(join(context.worktree, "late.txt"), "unvalidated change");
    git(context.worktree, "add", "late.txt"); git(context.worktree, "commit", "-m", "Change worktree after validation");
  }
  if (initial.orchestratorReworkOnce && last?.stage === "validate" && !context.stageHistory.some((item: any) => item.stage === "implement" && item.attempt > 1)) nextStage = "implement";
  if (initial.orchestratorReplanOnce && last?.stage === "implement" && !context.stageHistory.some((item: any) => item.stage === "plan" && item.attempt > 1)) nextStage = "plan";
  if (initial.orchestratorLoop && context.previousResults.analyze) nextStage = "plan";
  if (initial.orchestratorSkipToMerge) nextStage = "merge";
  const decision = {
    issueId: context.issueId, outcome: initial.orchestratorBlock ? "blocked" : initial.orchestratorPrematureComplete || context.canComplete ? "completed" : "dispatch",
    nextStage: initial.orchestratorBlock || initial.orchestratorPrematureComplete || context.canComplete ? null : nextStage,
    instructions: `Coordinator instruction for ${nextStage}: satisfy the issue and preserve existing acceptance.`,
    summary: initial.orchestratorBlock ?? (context.canComplete ? "Reviewed the executor's verified merge and Linear completion." : "Reviewed the current artifacts and selected the next stage."),
  };
  await emitResult(decision);
  process.exit(0);
}
const result: Record<string, any> = { issueId: context.issueId, stage: context.stage, outcome: "completed", complexity: null, commit: null, validatedBaseSha: null, validationCommentId: null, planDocumentId: null, planUrl: null, summary: `${kind} test fixture completed ${context.stage}` };
async function advanceBase() {
  await Bun.write(join(context.repo, "advanced.txt"), `advanced during ${context.stage} ${context.attempt}`);
  git(context.repo, "add", "advanced.txt"); git(context.repo, "commit", "-m", "Advance base");
}
switch (context.stage) {
  case "analyze":
    git(context.repo, "worktree", "add", "-b", context.branch, context.worktree, context.baseSha);
    helper("start", context.issueId);
    result.complexity = initial.complex ? "complex" : "simple";
    break;
  case "plan": {
    if (initial.missingPlanDocument) { result.planDocumentId = "missing"; result.planUrl = "https://linear.test/missing"; break; }
    const path = join(context.stageDir, "plan.md"); await Bun.write(path, `# Plan\n\nImplement the requested behavior and verify the result. Revision ${context.attempt}.`);
    const plan = helper("plan", context.issueId, "--file", path);
    result.planDocumentId = plan.id; result.planUrl = plan.url;
    break;
  }
  case "todos": {
    if (initial.missingTasks) {
      const state = await Bun.file(statePath).json();
      state.issues.find((issue: any) => issue.id === context.issueId).description += `\n\n## Implementation tasks (linear-auto-dev)\n\n[Implementation plan](${context.previousResults.plan.planUrl})\n`;
      await Bun.write(statePath, JSON.stringify(state));
      break;
    }
    const path = join(context.stageDir, "tasks.md"); await Bun.write(path, "- [ ] T01 — Implement and verify the requirement");
    helper("todos", context.issueId, "--file", path, "--plan-url", context.previousResults.plan.planUrl);
    break;
  }
  case "implement": {
    await Bun.write(join(context.worktree, `${context.identifier}.txt`), `implemented ${context.identifier}, attempt ${context.attempt}`);
    git(context.worktree, "add", "--", `${context.identifier}.txt`);
    git(context.worktree, "commit", "-m", `Implement ${context.identifier}`);
    if (context.previousResults.plan) {
      const path = join(context.stageDir, "tasks.md"); await Bun.write(path, "- [x] T01 — Implement and verify the requirement");
      helper("todos", context.issueId, "--file", path, "--plan-url", context.previousResults.plan.planUrl);
    }
    result.commit = git(context.worktree, "rev-parse", "HEAD");
    break;
  }
  case "validate": {
    git(context.worktree, "rebase", `refs/heads/${context.baseBranch}`);
    result.commit = git(context.worktree, "rev-parse", "HEAD");
    result.validatedBaseSha = git(context.repo, "rev-parse", `refs/heads/${context.baseBranch}`);
    const validation = join(context.stageDir, "validation.md");
    await Bun.write(validation, `Validation passed for ${result.commit}\n\nBase: ${result.validatedBaseSha}\nCommand: test fixture; exit code: 0`);
    result.validationCommentId = initial.missingValidationComment ? "missing" : helper("comment", context.issueId, "--file", validation, "--key", `${context.runId}-${result.commit}-${context.attempt}`).id;
    if (initial.alwaysAdvanceBase || (initial.advanceBaseOnce && context.attempt === 1)) await advanceBase();
    break;
  }
  case "merge": {
    const validation = context.previousResults.validate;
    result.commit = validation.commit; result.validatedBaseSha = validation.validatedBaseSha; result.validationCommentId = validation.validationCommentId;
    if (initial.advanceBaseAtMerge && context.attempt === 1) { await advanceBase(); result.outcome = "needs_validation"; break; }
    if (!initial.falseComplete) {
      let integration = context.repo;
      if (git(integration, "branch", "--show-current") !== context.baseBranch) {
        integration = join(context.runDir, "integration");
        git(context.repo, "worktree", "add", integration, context.baseBranch);
      }
      git(integration, "merge", "--ff-only", context.branch);
    }
    const path = join(context.stageDir, "merge.md"); await Bun.write(path, `Merged ${result.commit} into ${context.baseBranch}`);
    helper("comment", context.issueId, "--file", path, "--key", `${context.runId}-merge`);
    helper("done", context.issueId);
    break;
  }
  default: throw new Error(`Unhandled stage ${context.stage}`);
}
await emitResult(result);

export {};
