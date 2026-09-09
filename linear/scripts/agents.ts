import { dirname, join } from "node:path";
import { command } from "./linear-client";

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
  herdrBin?: string;
};
export type ResolvedAgent = Required<AgentConfig> & { binary: string };
export type RoleAgents = Record<Role, ResolvedAgent>;

export type Herdr = { bin: string; env: NodeJS.ProcessEnv };

export function makeHerdr(bin: string | undefined, socketPath: string | undefined, baseEnv: NodeJS.ProcessEnv = process.env): Herdr {
  const found = Bun.which(bin ?? "herdr");
  if (!found) throw new Error(`Executable not found: ${bin ?? "herdr"}`);
  const env = { ...baseEnv };
  if (socketPath) env.HERDR_SOCKET_PATH = socketPath;
  return { bin: found, env };
}

async function herdrCommand(herdr: Herdr, args: string[], timeoutMs: number) {
  if (timeoutMs <= 0) throw new Error("Issue timeout exceeded before calling herdr");
  return command([herdr.bin, ...args], { env: herdr.env, timeoutMs: timeoutMs + 15_000 });
}

async function herdrJson(herdr: Herdr, args: string[], timeoutMs: number): Promise<any> {
  return JSON.parse(await herdrCommand(herdr, args, timeoutMs));
}

export async function createHerdrWorktree(herdr: Herdr, repo: string, branch: string, baseRef: string, label: string, timeoutMs = 120_000) {
  const out = await herdrJson(herdr, ["worktree", "create", "--cwd", repo, "--branch", branch, "--base", baseRef, "--label", label, "--no-focus"], timeoutMs);
  const workspaceId = out?.result?.workspace?.workspace_id;
  const rootPane = out?.result?.root_pane?.pane_id;
  const worktree = out?.result?.worktree?.path;
  if (typeof workspaceId !== "string" || typeof rootPane !== "string" || typeof worktree !== "string" || out?.result?.worktree?.branch !== branch) {
    throw new Error(`Unexpected herdr worktree create response: ${JSON.stringify(out).slice(0, 1000)}`);
  }
  return { workspaceId, rootPane, worktree };
}

export async function closeHerdrWorkspace(herdr: Herdr, workspaceId: string, timeoutMs = 30_000) {
  await herdrJson(herdr, ["workspace", "close", workspaceId], timeoutMs);
}

// Connectivity preflight for --install: fails when no Herdr server answers on the socket.
export async function herdrPing(herdr: Herdr) {
  await herdrJson(herdr, ["workspace", "list"], 15_000);
}

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
    ? ["--cd", "-C", "--model", "-m"]
    : ["--dir", "--model", "-m", "--variant", "--attach", "--command", "--session", "-s", "--continue", "-c", "--fork"];
  for (const arg of agent.extraArgs) {
    if (arg === "--" || owned.some((flag) => arg === flag || arg.startsWith(flag + "=") || (flag.length === 2 && arg.startsWith(flag) && arg.length > 2))) {
      throw new Error(`${path}.extraArgs cannot override managed transport argument ${arg}; use model or reasoningEffort for those settings`);
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

// Native arguments passed after `--` to `herdr agent start`. The pane provides cwd and
// environment; herdr launches the interactive TUI, so headless transport flags do not apply.
export function agentArgs(agent: ResolvedAgent): string[] {
  if (agent.agent === "codex") {
    return ["--dangerously-bypass-approvals-and-sandbox", ...agent.extraArgs,
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`] : [])];
  }
  return ["--auto", ...agent.extraArgs,
    ...(agent.model ? ["--model", agent.model] : []), ...(agent.reasoningEffort ? ["--variant", agent.reasoningEffort] : [])];
}

function paneEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("HERDR_") || value.includes("\0")) continue;
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

export class AgentCleanupError extends Error {}

export type HerdrLaunch = {
  herdr: Herdr; workspaceId: string; rootPane: string; name: string; cwd: string;
  stageDir: string; contextPath: string; schemaPath: string; prompt: string;
  timeoutMs: number; signal?: AbortSignal; env: NodeJS.ProcessEnv;
  onPane?: (paneId: string) => void;
};

// Every stage runs as a named agent in a dedicated worker pane inside the issue's Herdr
// workspace. The pane is created fresh per stage and always closed afterwards, which reaps
// the agent process; all handoff happens through files on disk (result.json) and Linear.
export async function runAgent(agent: ResolvedAgent, input: HerdrLaunch) {
  if (input.signal?.aborted) throw new Error("Interrupted before starting the stage");
  if (input.timeoutMs <= 0) throw new Error("Issue timeout exceeded before starting the stage");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name)) throw new Error(`Invalid herdr agent name: ${input.name}`);
  const resultPath = join(input.stageDir, "result.json");
  const transcriptPath = join(input.stageDir, `${input.name}.tui.log`);
  const deadline = Date.now() + input.timeoutMs;
  const left = () => deadline - Date.now();
  const env: NodeJS.ProcessEnv = { ...input.env, LINEAR_WATCH_CONTEXT: input.contextPath };
  const binDir = dirname(agent.binary);
  if (!env.PATH?.split(":").includes(binDir)) env.PATH = [binDir, env.PATH ?? ""].filter(Boolean).join(":");

  const split = await herdrJson(input.herdr, ["pane", "split", input.rootPane, "--direction", "right", "--cwd", input.cwd, "--no-focus", ...paneEnvArgs(env)], left());
  const paneId = split?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) throw new Error(`herdr pane split did not return a pane id: ${JSON.stringify(split).slice(0, 500)}`);
  input.onPane?.(paneId);

  const promptAgent = async (text: string, waitMs: number) => {
    const out = await herdrJson(input.herdr, ["agent", "prompt", input.name, text, "--wait", "--timeout", String(waitMs)], waitMs);
    const status = out?.result?.agent?.agent_status;
    if (status === "blocked") {
      await captureTranscript();
      throw new Error(`${agent.agent} agent ${input.name} is blocked waiting for interactive input; inspect ${transcriptPath}`);
    }
  };
  const captureTranscript = async () => {
    try { await Bun.write(transcriptPath, await herdrCommand(input.herdr, ["agent", "read", input.name, "--source", "recent-unwrapped", "--lines", "500"], Math.min(left(), 30_000))); }
    catch { /* transcript is best effort */ }
  };
  const closePane = async () => {
    try { await herdrJson(input.herdr, ["pane", "close", paneId], Math.max(Math.min(left(), 30_000), 15_000)); }
    catch (error: any) {
      if (String(error?.message).includes("pane_not_found")) return;
      throw new AgentCleanupError(`Could not close herdr pane ${paneId} for agent ${input.name}: ${error.message}`);
    }
  };
  const abortClose = () => { void herdrCommand(input.herdr, ["pane", "close", paneId], 15_000).catch(() => {}); };
  input.signal?.addEventListener("abort", abortClose, { once: true });

  try {
    const started = await herdrJson(input.herdr, ["agent", "start", input.name, "--kind", agent.agent, "--pane", paneId, "--", ...agentArgs(agent)], left());
    if (started?.result?.agent?.name !== input.name || started?.result?.agent?.pane_id !== paneId) {
      throw new Error(`herdr agent start did not confirm ${input.name} in pane ${paneId}: ${JSON.stringify(started).slice(0, 500)}`);
    }
    try {
      await promptAgent(input.prompt, left());
      if (!(await Bun.file(resultPath).exists())) {
        await promptAgent(`尚未在 ${resultPath} 找到本阶段结果。请立即把符合 ${input.schemaPath} 的 JSON 写入该文件（覆盖占位内容即可），并把同一 JSON 作为最终回答；不要执行其他工作。`, left());
      }
    } catch (error) {
      await captureTranscript();
      if (input.signal?.aborted) throw new Error(`Interrupted during ${input.name}; closed pane ${paneId} and preserved the worktree and logs`);
      throw error;
    }
    await captureTranscript();
    if (!(await Bun.file(resultPath).exists())) throw new Error(`${agent.agent} agent ${input.name} did not produce a stage result: ${resultPath} (transcript: ${transcriptPath})`);
    return Bun.file(resultPath).json();
  } finally {
    input.signal?.removeEventListener("abort", abortClose);
    await closePane();
  }
}
