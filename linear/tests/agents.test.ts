import { describe, expect, test } from "bun:test";
import { agentArgs, resolveRoleAgents, type AgentSettings } from "../scripts/agents";
import { parseOrchestratorResult, parseStageResult } from "../scripts/stages";

const argsFor = (settings: AgentSettings) => agentArgs(resolveRoleAgents(settings).executor, "/repo", "/run/result.json", "/schema.json");

describe("agent configuration", () => {
  test("inherits defaults by role and field and keeps legacy model config working", () => {
    const agents = resolveRoleAgents({
      model: "legacy-model",
      defaults: { reasoningEffort: "high", extraArgs: ["--profile", "development"] },
      agents: { executor: { model: "implementation-model", reasoningEffort: "xhigh" } },
    });
    expect(agents.planner.model).toBe("legacy-model");
    expect(agents.planner.reasoningEffort).toBe("high");
    expect(agents.executor.model).toBe("implementation-model");
    expect(agents.executor.reasoningEffort).toBe("xhigh");
    expect(agents.executor.extraArgs).toEqual(["--profile", "development"]);
    expect(resolveRoleAgents({}).executor.reasoningEffort).toBe("xhigh");
  });

  test("switching agent kinds resets incompatible model, effort and CLI flags", () => {
    const agents = resolveRoleAgents({
      defaults: { agent: "codex", model: "codex-model", reasoningEffort: "xhigh", extraArgs: ["--profile", "dev"] },
      agents: { planner: { agent: "opencode" }, executor: { agent: "opencode", reasoningEffort: "high" } },
    });
    expect(agents.planner.model).toBeNull();
    expect(agents.planner.reasoningEffort).toBeNull();
    expect(agents.planner.extraArgs).toEqual([]);
    expect(agents.executor.reasoningEffort).toBe("high");
    const reverse = resolveRoleAgents({ defaults: { agent: "opencode", model: "provider/model", extraArgs: ["--agent", "build"] }, agents: { executor: { agent: "codex" } } });
    expect(reverse.executor.model).toBeNull();
    expect(reverse.executor.reasoningEffort).toBe("xhigh");
    expect(reverse.executor.extraArgs).toEqual([]);
  });

  test("explicit null and an empty array clear inherited CLI settings", () => {
    const args = argsFor({ defaults: { model: "model", reasoningEffort: "high", extraArgs: ["--profile", "dev"] }, agents: { executor: { model: null, reasoningEffort: null, extraArgs: [] } } });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("-c");
    expect(args).not.toContain("--profile");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("maps model and effort to the selected CLI and replaces extraArgs", () => {
    const codex = argsFor({ defaults: { model: "codex-model", reasoningEffort: "medium" } });
    expect(codex).toContain("codex-model");
    expect(codex).toContain('model_reasoning_effort="medium"');
    const opencode = argsFor({
      defaults: { agent: "opencode", model: "provider/model", reasoningEffort: "high", extraArgs: ["--title", "inherited"] },
      agents: { executor: { extraArgs: ["--agent", "build"] } },
    });
    expect(opencode.slice(1)).toEqual(["run", "--auto", "--agent", "build", "--model", "provider/model", "--variant", "high", "--dir", "/repo", "--format", "json"]);
    expect(opencode).not.toContain("inherited");
  });

  test("rejects invalid or conflicting settings before launching a stage", () => {
    const invalid: unknown[] = [
      { defaults: { agent: "other" } }, { defaults: { model: "" } }, { defaults: { reasoningEffort: 5 } },
      { agents: { planning: {} } }, { agents: { planner: null } }, { defaults: { extraArgs: "--verbose" } },
      { defaults: { extraArgs: ["--profile", 5] } }, { defaults: { extraArgs: ["bad\0arg"] } },
      { defaults: { extraArgs: ["--cd=/tmp"] } }, { defaults: { extraArgs: ["-mother-model"] } },
      { defaults: { agent: "opencode", extraArgs: ["--format", "text"] } },
      { defaults: { agent: "opencode", extraArgs: ["--variant=high"] } },
      { defaults: { extraArgs: ["--"] } }, { defaults: { reasoning: "high" } },
      { stages: { merge: { agent: "opencode" } } }, { agents: { merge: {} } },
    ];
    for (const settings of invalid) expect(() => resolveRoleAgents(settings as AgentSettings)).toThrow();
  });

  test("rejects a wrong issue/stage or incomplete structured result", () => {
    const result = { issueId: "issue", stage: "analyze", outcome: "completed", complexity: "simple", commit: null, validatedBaseSha: null, validationCommentId: null, planDocumentId: null, planUrl: null, summary: "Analyzed" };
    expect(parseStageResult(result, "analyze", "issue").complexity).toBe("simple");
    expect(() => parseStageResult(result, "plan", "issue")).toThrow("does not match");
    expect(() => parseStageResult(result, "analyze", "other")).toThrow("does not match");
    expect(() => parseStageResult({ ...result, commit: undefined }, "analyze", "issue")).toThrow("commit");
    expect(() => parseStageResult({ ...result, outcome: "needs_validation" }, "analyze", "issue")).toThrow("Only merge");
    expect(() => parseStageResult({ ...result, outcome: "blocked", summary: "Missing dependency" }, "analyze", "issue")).toThrow("Missing dependency");
  });

  test("validates orchestration decisions against available handoffs and verified completion", () => {
    const decision = { issueId: "issue", outcome: "dispatch", nextStage: "plan", instructions: "Resolve the design uncertainty", summary: "Planning required" };
    expect(parseOrchestratorResult(decision, "issue", ["plan"], false).nextStage).toBe("plan");
    expect(() => parseOrchestratorResult(decision, "other", ["plan"], false)).toThrow("dispatched issue");
    expect(() => parseOrchestratorResult({ ...decision, nextStage: "merge" }, "issue", ["plan"], false)).toThrow("cannot dispatch");
    const done = { ...decision, outcome: "completed", nextStage: null };
    expect(() => parseOrchestratorResult(done, "issue", ["plan"], false)).toThrow("before a verified merge");
    expect(parseOrchestratorResult(done, "issue", [], true).outcome).toBe("completed");
    expect(() => parseOrchestratorResult({ ...decision, outcome: "blocked" }, "issue", ["plan"], false)).toThrow("nextStage=null");
  });
});
