import { join } from "node:path";

export const STAGES = ["analyze", "plan", "todos", "implement", "validate", "merge"] as const;
export type Stage = typeof STAGES[number];
export const ROLES = ["orchestrator", "planner", "executor"] as const;
export type Role = typeof ROLES[number];
export const STAGE_ROLES: Record<Stage, Exclude<Role, "orchestrator">> = {
  analyze: "planner", plan: "planner", todos: "planner",
  implement: "executor", validate: "executor", merge: "executor",
};
export type AgentKind = "codex" | "opencode";
export type AgentConfig = {
  agent?: AgentKind;
  model?: string | null;
  reasoningEffort?: string | null;
  extraArgs?: string[];
};
export type AgentSettings = {
  defaults?: AgentConfig;
  agents?: Partial<Record<Role, AgentConfig>>;
  model?: string; // Compatibility with the original Codex-only config.
  codexBin?: string;
  opencodeBin?: string;
};
export type ResolvedAgent = Required<AgentConfig> & { binary: string };
export type RoleAgents = Record<Role, ResolvedAgent>;

function validateConfig(value: unknown, path: string): asserts value is AgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an agent config object`);
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) if (!["agent", "model", "reasoningEffort", "extraArgs"].includes(key)) throw new Error(`Unknown ${path}.${key}`);
  if (config.agent !== undefined && config.agent !== "codex" && config.agent !== "opencode") throw new Error(`${path}.agent must be codex or opencode`);
  for (const key of ["model", "reasoningEffort"] as const) {
    const field = config[key];
    if (field !== undefined && field !== null && (typeof field !== "string" || !field.trim())) throw new Error(`${path}.${key} must be a non-empty string or null`);
  }
  if (config.extraArgs !== undefined && (!Array.isArray(config.extraArgs) || !config.extraArgs.every((arg) => typeof arg === "string" && !arg.includes("\0")))) {
    throw new Error(`${path}.extraArgs must be an array of argument strings, not a shell command`);
  }
}

const builtIn = (agent: AgentKind): Required<AgentConfig> => ({ agent, model: null, reasoningEffort: agent === "codex" ? "xhigh" : null, extraArgs: [] });
function overlay(base: Required<AgentConfig>, override: AgentConfig): Required<AgentConfig> {
  const target = override.agent ?? base.agent;
  // Models, variants, and CLI flags belong to one agent kind. A kind change starts with its own defaults.
  return { ...(target === base.agent ? base : builtIn(target)), ...override };
}

function validateTransport(agent: Required<AgentConfig>, path: string) {
  const owned = agent.agent === "codex"
    ? ["--cd", "-C", "--output-last-message", "-o", "--output-schema", "--json", "--color", "--model", "-m"]
    : ["--dir", "--format", "--model", "-m", "--variant", "--attach", "--command", "--session", "-s", "--continue", "-c", "--fork"];
  for (const arg of agent.extraArgs) {
    if (arg === "--" || owned.some((flag) => arg === flag || arg.startsWith(flag + "=") || (flag.length === 2 && arg.startsWith(flag) && arg.length > 2))) {
      throw new Error(`${path}.extraArgs cannot override managed transport/model argument ${arg}; use model or reasoningEffort for those settings`);
    }
  }
}

export function resolveRoleAgents(config: AgentSettings): RoleAgents {
  if ("stages" in config) throw new Error("Move stages agent settings to agents.orchestrator, agents.planner and agents.executor; stage ownership is fixed by role");
  if (config.defaults !== undefined) validateConfig(config.defaults, "defaults");
  if (config.agents !== undefined && (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents))) throw new Error("agents must be an object");
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    if (!ROLES.includes(name as Role)) throw new Error(`Unknown agent role ${name}; expected ${ROLES.join(", ")}`);
    validateConfig(agent, `agents.${name}`);
  }
  const defaults = overlay({ ...builtIn("codex"), model: config.model ?? null }, config.defaults ?? {});
  return Object.fromEntries(ROLES.map((role) => {
    const agent = overlay(defaults, config.agents?.[role] ?? {});
    validateTransport(agent, `agents.${role}`);
    const name = (agent.agent === "codex" ? config.codexBin : config.opencodeBin) ?? agent.agent;
    return [role, { ...agent, extraArgs: [...agent.extraArgs], binary: Bun.which(name) ?? name }];
  })) as RoleAgents;
}

export function agentArgs(agent: ResolvedAgent, cwd: string, resultPath: string, schemaPath: string) {
  if (agent.agent === "codex") {
    return [agent.binary, "exec", "--dangerously-bypass-approvals-and-sandbox", ...agent.extraArgs,
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`] : []),
      "--cd", cwd, "--json", "--color", "never", "--output-schema", schemaPath, "--output-last-message", resultPath, "-"];
  }
  return [agent.binary, "run", "--auto", ...agent.extraArgs,
    ...(agent.model ? ["--model", agent.model] : []), ...(agent.reasoningEffort ? ["--variant", agent.reasoningEffort] : []),
    "--dir", cwd, "--format", "json"];
}

export class AgentCleanupError extends Error {}

export async function runAgent(agent: ResolvedAgent, input: {
  cwd: string; stageDir: string; contextPath: string; prompt: string; schemaPath: string;
  timeoutMs: number; signal?: AbortSignal; env: NodeJS.ProcessEnv;
  onChild?: (pid: number) => void;
}) {
  if (input.signal?.aborted) throw new Error("Interrupted before starting the stage");
  if (input.timeoutMs <= 0) throw new Error("Issue timeout exceeded before starting the stage");
  if (!Bun.which(agent.binary)) throw new Error(`Executable not found for ${agent.agent}: ${agent.binary}`);
  const resultPath = join(input.stageDir, "result.json");
  const stdoutPath = join(input.stageDir, `${agent.agent}.jsonl`);
  const stderrPath = join(input.stageDir, `${agent.agent}.stderr.log`);
  const child = Bun.spawn(agentArgs(agent, input.cwd, resultPath, input.schemaPath), {
    cwd: input.cwd, stdin: new Blob([input.prompt]), stdout: Bun.file(stdoutPath), stderr: Bun.file(stderrPath),
    detached: process.platform !== "win32", env: { ...input.env, LINEAR_WATCH_CONTEXT: input.contextPath },
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
  };
  let timedOut = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { killGroup("SIGTERM"); grace ??= setTimeout(() => killGroup("SIGKILL"), 10_000); };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);
  input.signal?.addEventListener("abort", stop, { once: true });
  let code: number;
  try {
    input.onChild?.(child.pid);
    if (input.signal?.aborted) stop();
    code = await child.exited;
  } finally {
    clearTimeout(timeout); clearTimeout(grace); input.signal?.removeEventListener("abort", stop);
    try { killGroup("SIGKILL"); await child.exited; }
    catch (error: any) { throw new AgentCleanupError(`Could not terminate ${agent.agent} process group ${child.pid}: ${error.message}`); }
  }
  if (timedOut) throw new Error(`Issue timeout exceeded during ${agent.agent}; inspect ${input.stageDir}`);
  if (input.signal?.aborted) throw new Error("Interrupted; inspect the preserved worktree and stage logs before resuming");
  if (code !== 0) throw new Error(`${agent.agent} exited ${code}; see ${stderrPath}`);
  if (agent.agent === "opencode") {
    let lastText: string | undefined;
    for (const line of (await Bun.file(stdoutPath).text()).split("\n")) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "error") throw new Error(`OpenCode reported an error: ${JSON.stringify(event.error).slice(0, 2000)}`);
      if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.trim()) lastText = event.part.text;
    }
    if (!(await Bun.file(resultPath).exists()) && lastText) {
      // OpenCode has no --output-last-message. Accept its final JSON text when the agent did not write the result file.
      const text = lastText.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
      await Bun.write(resultPath, JSON.stringify(JSON.parse(text), null, 2));
    }
  }
  if (!(await Bun.file(resultPath).exists())) throw new Error(`${agent.agent} did not produce a stage result: ${resultPath}`);
  return Bun.file(resultPath).json();
}
