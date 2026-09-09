#!/usr/bin/env bun
// Fake herdr CLI for linear-watch tests. Persists workspaces/panes/agents in
// LINEAR_HERDR_STATE and executes stage agents synchronously during `agent prompt`,
// killing the child on --timeout or `pane close` the way a real pane teardown reaps it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type Pane = { workspace: string; cwd: string; env: Record<string, string>; alive: boolean; childPid?: number };
type Agent = { pane: string; kind: string; args: string[]; alive: boolean; prompts: number };
type State = { seq: number; workspaces: Record<string, { label: string; closed: boolean }>; panes: Record<string, Pane>; agents: Record<string, Agent> };

const statePath = process.env.LINEAR_HERDR_STATE;
if (!statePath) { process.stderr.write("LINEAR_HERDR_STATE is not set"); process.exit(1); }
const load = (): State => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { seq: 0, workspaces: {}, panes: {}, agents: {} };
const save = (state: State) => writeFileSync(statePath, JSON.stringify(state));
function fail(code: string, message: string): never { process.stderr.write(JSON.stringify({ error: { code, message } })); process.exit(1); }

const args = Bun.argv.slice(2);
const [group, sub, ...rest] = args;
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const bool = (name: string) => args.includes(name);
const json = (result: unknown) => { console.log(JSON.stringify({ id: `cli:${group}:${sub?.replace(/-/g, "")}`, result })); process.exit(0); };
const git = (at: string, ...cmd: string[]) => {
  const out = Bun.spawnSync(["git", "-C", at, ...cmd], { stderr: "pipe" });
  if (out.exitCode !== 0) fail("git_failed", out.stderr.toString());
  return out.stdout.toString().trim();
};

const state = load();

if (group === "workspace" && sub === "list") json({ type: "workspace_list", workspaces: Object.entries(state.workspaces).filter(([, w]) => !w.closed).map(([id, w]) => ({ workspace_id: id, label: w.label })) });
if (group === "workspace" && sub === "close") {
  if (!state.workspaces[rest[0]!] || state.workspaces[rest[0]!].closed) fail("workspace_not_found", `workspace ${rest[0]} not found`);
  state.workspaces[rest[0]!].closed = true;
  for (const pane of Object.values(state.panes)) {
    if (pane.workspace !== rest[0] || !pane.alive) continue;
    pane.alive = false;
    if (pane.childPid) { try { process.kill(-pane.childPid, "SIGKILL"); } catch { /* already gone */ } pane.childPid = undefined; }
  }
  save(state); json({ type: "ok" });
}

if (group === "worktree" && sub === "create") {
  const repo = flag("--cwd"), branch = flag("--branch"), base = flag("--base"), label = flag("--label") ?? branch ?? "worktree";
  if (!repo || !branch || !base) fail("invalid_args", "worktree create needs --cwd --branch --base");
  const path = join(dirname(repo), `.herdr-worktrees-${basename(repo)}`, branch.replace(/[^a-zA-Z0-9]+/g, "-"));
  mkdirSync(dirname(path), { recursive: true });
  git(repo, "worktree", "add", "-b", branch, path, base);
  state.seq += 1;
  const workspaceId = `xw${state.seq}`;
  state.workspaces[workspaceId] = { label, closed: false };
  state.panes[`${workspaceId}:p1`] = { workspace: workspaceId, cwd: path, env: {}, alive: true };
  save(state);
  json({ type: "worktree_created", workspace: { workspace_id: workspaceId, label }, root_pane: { pane_id: `${workspaceId}:p1`, cwd: path }, worktree: { path, branch } });
}

if (group === "pane" && sub === "split") {
  const target = rest[0];
  if (!state.panes[target!] || !state.panes[target!].alive) fail("pane_not_found", `pane ${target} not found`);
  const cwd = flag("--cwd") ?? state.panes[target!].cwd;
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i] === "--env") {
    const [key, ...value] = (args[i + 1] as string).split("=");
    env[key!] = value.join("=");
  }
  state.seq += 1;
  const paneId = `${state.panes[target!]!.workspace}:p${state.seq}`;
  state.panes[paneId] = { workspace: state.panes[target!]!.workspace, cwd, env, alive: true };
  save(state);
  json({ type: "pane_split", pane: { pane_id: paneId, cwd } });
}

if (group === "pane" && sub === "close") {
  const pane = state.panes[rest[0]!];
  if (!pane || !pane.alive) fail("pane_not_found", `pane ${rest[0]} not found`);
  pane.alive = false;
  if (pane.childPid) { try { process.kill(-pane.childPid, "SIGKILL"); } catch { /* already gone */ } pane.childPid = undefined; }
  save(state); json({ type: "ok" });
}

if (group === "agent" && sub === "start") {
  const name = rest[0];
  const kind = flag("--kind"), pane = flag("--pane");
  const dashDash = args.indexOf("--");
  const agentArgs = dashDash >= 0 ? args.slice(dashDash + 1) : [];
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name ?? "")) fail("invalid_name", `invalid agent name ${name}`);
  if (!state.panes[pane!] || !state.panes[pane!].alive) fail("pane_not_found", `pane ${pane} not found`);
  if (state.agents[name] && state.agents[name].alive && state.panes[state.agents[name]!.pane]?.alive) fail("agent_exists", `agent ${name} already running`);
  state.agents[name!] = { pane: pane!, kind: kind!, args: agentArgs, alive: true, prompts: 0 };
  save(state);
  json({ type: "agent_started", agent: { name, pane_id: pane, agent: kind, agent_status: "idle", cwd: state.panes[pane!]!.cwd } });
}

if (group === "agent" && sub === "prompt") {
  const name = rest[0], text = rest[1];
  const agent = state.agents[name];
  if (!agent || !agent.alive) fail("agent_not_found", `agent target ${name} not found`);
  const pane = state.panes[agent.pane];
  if (!pane || !pane.alive) fail("pane_not_found", `pane ${agent.pane} not found`);
  agent.prompts += 1;
  const timeoutMs = Number(flag("--timeout") ?? "0");
  const child = Bun.spawn([agent.kind, ...agent.args], {
    cwd: pane.cwd, stdin: new Blob([text]), stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, ...pane.env, LINEAR_FAKE_PROMPT_COUNT: String(agent.prompts) },
  });
  pane.childPid = child.pid; save(state);
  let timedOut = false;
  const killer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  void stdout;
  clearTimeout(killer);
  pane.childPid = undefined;
  if (timedOut) fail("wait_timeout", `agent ${name} prompt timed out after ${timeoutMs}ms; child killed`);
  if (bool("--wait") && code !== 0) fail("agent_failed", `${agent.kind} exited ${code}: ${stderr.slice(0, 2000)}`);
  json({ type: "agent_prompted", agent: { name, pane_id: agent.pane, agent: agent.kind, agent_status: "done", last_exit: code } });
}

if (group === "agent" && sub === "read") {
  const name = rest[0];
  if (!state.agents[name]) fail("agent_not_found", `agent target ${name} not found`);
  console.log(`fake transcript for ${name}`);
  process.exit(0);
}

if (group === "agent" && sub === "send-keys") json({ type: "ok" });
fail("unimplemented", `fake herdr does not implement: ${args.join(" ")}`);
