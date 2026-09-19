#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LinearClient, type Issue } from "./linear-client";

export const TODO_HEADING = "## Implementation tasks (linear-auto-dev)";

export async function listTodoIssues(client: LinearClient, state = "Todo") {
  const expected = state.toLowerCase();
  const issues = (await client.todoIssues()).filter((issue) => !issue.archivedAt && issue.state.type === "unstarted"
    && [issue.state.id, issue.state.name].some((value) => value.toLowerCase() === expected));
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()]
    .sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.createdAt.localeCompare(b.createdAt) || a.identifier.localeCompare(b.identifier));
}

function sectionHeadings(markdown: string) {
  const headings: { text: string; index: number; end: number }[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const match of markdown.matchAll(/^.*(?:\n|$)/gm)) {
    const line = match[0].replace(/\r?\n$/, "");
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { character: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.character && marker[1]!.length >= fence.length && line.slice(marker[0].length).trim() === "") fence = undefined;
      continue;
    }
    if (!fence && /^#{1,2}\s/.test(line)) headings.push({ text: line.trimEnd(), index: match.index!, end: match.index! + match[0].length });
  }
  return headings;
}

export function readTodoSection(description: string) {
  const headings = sectionHeadings(description);
  const managed = headings.filter((heading) => heading.text === TODO_HEADING);
  if (managed.length !== 1) return null;
  const start = managed[0]!;
  const end = headings.find((heading) => heading.index > start.index)?.index ?? description.length;
  return description.slice(start.end, end);
}

export function replaceTodoSection(description: string, tasks: string, planUrl: string) {
  if (!/^- \[[ xX]\] .+/m.test(tasks)) throw new Error("Task file must contain Markdown checkboxes");
  if (sectionHeadings(tasks).length) throw new Error("Use ### or deeper headings inside the task file");
  const headings = sectionHeadings(description);
  const managed = headings.filter((heading) => heading.text === TODO_HEADING);
  if (managed.length > 1) throw new Error("Duplicate managed task sections; reconcile them before updating");
  const section = `${TODO_HEADING}\n\n[Implementation plan](${planUrl})\n\n${tasks.trim()}\n`;
  if (!managed.length) return `${description}${description ? "\n\n" : ""}${section}`;
  const start = managed[0]!.index;
  const end = headings.find((heading) => heading.index > start)?.index ?? description.length;
  return description.slice(0, start) + section + (end < description.length ? "\n" + description.slice(end) : "");
}

export async function publishPlan(client: LinearClient, issue: Issue, content: string) {
  const title = `${issue.identifier} — Implementation plan`;
  const matches = (await client.documents(issue.id)).filter((doc) => doc.title === title);
  if (matches.length > 1) throw new Error("Multiple implementation plans found; select the existing document explicitly");
  const existing = matches[0];
  if (existing?.content === content) return existing;
  const data = existing
    ? await client.request(`mutation LinearPlanUpdate($id: String!, $input: DocumentUpdateInput!) {
        documentUpdate(id: $id, input: $input) { success document { id title content url } }
      }`, { id: existing.id, input: { content } }, true)
    : await client.request(`mutation LinearPlanCreate($input: DocumentCreateInput!) {
        documentCreate(input: $input) { success document { id title content url } }
      }`, { input: { title, content, issueId: issue.id } }, true);
  const result = existing ? data.documentUpdate : data.documentCreate;
  if (!result?.success || !result.document?.url) throw new Error("Linear did not confirm the plan document");
  const saved = (await client.documents(issue.id)).find((doc) => doc.id === result.document.id);
  if (!saved) throw new Error("Plan was not found on the issue after publishing");
  return saved;
}

export async function publishTodos(client: LinearClient, id: string, tasks: string, planUrl: string) {
  const issue = await client.issue(id);
  if (!(await client.documents(issue.id)).some((doc) => doc.url === planUrl)) throw new Error("Plan URL must identify a document attached to this issue");
  const description = replaceTodoSection(issue.description ?? "", tasks, planUrl);
  // Refresh before a whole-description update so an observed concurrent human edit is never overwritten.
  const fresh = await client.issue(issue.id);
  if (fresh.updatedAt !== issue.updatedAt || fresh.description !== issue.description) throw new Error("Issue changed while preparing tasks; reread it and retry with the latest content");
  await client.updateIssue(issue.id, { description });
  const saved = await client.issue(issue.id);
  if (saved.description !== description) throw new Error("Description readback differs; inspect Linear before retrying");
  return { id: saved.id, url: saved.url };
}

export async function transition(client: LinearClient, id: string, type: "started" | "completed", name?: string) {
  const issue = await client.issue(id);
  const states = await client.pages<{ id: string; name: string; type: string }>(`query LinearWorkflowStates($team: ID!, $after: String) {
    workflowStates(first: 100, after: $after, filter: { team: { id: { eq: $team } } }) {
      nodes { id name type } pageInfo { hasNextPage endCursor }
    }
  }`, { team: issue.team.id }, (data) => data.workflowStates);
  const candidates = states.filter((state) => state.type === type);
  const preferred = name ?? (type === "started" ? "In Progress" : "Done");
  let matches = candidates.filter((state) => state.id === preferred || state.name.toLowerCase() === preferred.toLowerCase());
  if (!name && !matches.length && candidates.length === 1) matches = candidates;
  if (matches.length !== 1) throw new Error(`Cannot uniquely resolve ${type} state; pass --state with an actual team state name or ID`);
  await client.updateIssue(issue.id, { stateId: matches[0]!.id });
  const saved = await client.issue(issue.id);
  if (saved.state.id !== matches[0]!.id) throw new Error("Issue status readback did not match the requested status");
  return { id: saved.id, state: saved.state };
}

export async function uploadArtifact(client: LinearClient, path: string) {
  const file = Bun.file(resolve(path));
  if (!(await file.exists()) || file.size === 0) throw new Error(`Missing or empty artifact: ${path}`);
  const data = await client.request(`mutation LinearValidationUpload($type: String!, $name: String!, $size: Int!) {
    fileUpload(contentType: $type, filename: $name, size: $size) {
      success uploadFile { uploadUrl assetUrl headers { key value } }
    }
  }`, { type: file.type || "application/octet-stream", name: basename(path), size: file.size }, true);
  const upload = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !upload?.uploadUrl || !upload?.assetUrl) throw new Error("Linear did not return an artifact upload URL");
  const response = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream", "Cache-Control": "public, max-age=31536000", ...Object.fromEntries((upload.headers ?? []).map((h: any) => [h.key, h.value])) },
    body: file,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Artifact upload failed (${response.status}): ${basename(path)}`);
  return { name: basename(path), url: upload.assetUrl };
}

export async function publishComment(client: LinearClient, id: string, body: string, key: string, artifacts: string[] = []) {
  if (!body.trim()) throw new Error("Comment body is empty");
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error("Comment --key must use letters, digits, dots, underscores or hyphens");
  const issue = await client.issue(id);
  const marker = `Run: \`${key}\``;
  const existing = (await client.comments(issue.id)).filter((comment) => comment.body.split("\n").includes(marker));
  if (existing.length > 1) throw new Error("Duplicate comment keys; inspect the issue before continuing");
  if (existing[0]) return existing[0];
  const links: string[] = [];
  for (const path of artifacts) {
    const artifact = await uploadArtifact(client, path);
    links.push(`- [${artifact.name.replace(/[\[\]\\]/g, "\\$&")}](${artifact.url})`);
  }
  const finalBody = `${body.trim()}${links.length ? `\n\nValidation artifacts:\n\n${links.join("\n")}` : ""}\n\n${marker}`;
  const data = await client.request(`mutation LinearValidationComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id body url } }
  }`, { input: { issueId: issue.id, body: finalBody } }, true);
  if (!data.commentCreate?.success || !data.commentCreate.comment?.id) throw new Error("Linear did not confirm the comment");
  const saved = (await client.comments(issue.id)).find((comment) => comment.id === data.commentCreate.comment.id);
  if (!saved) throw new Error("Comment was not found on the issue after publishing");
  return saved;
}

export async function main(args = Bun.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: "string" }, "plan-url": { type: "string" }, key: { type: "string" },
    artifact: { type: "string", multiple: true }, state: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("bun linear/scripts/linear-issue.ts list-todo [--state NAME_OR_ID]");
    console.log("bun linear/scripts/linear-issue.ts get|start|done|plan|todos|comment ISSUE [--file FILE] [--plan-url URL] [--key KEY] [--artifact FILE ...] [--state NAME_OR_ID]");
    return;
  }
  const [action, id] = positionals;
  if (action === "list-todo") {
    if (positionals.length !== 1) throw new Error("list-todo does not accept an issue ID; use --help");
    console.log(JSON.stringify(await listTodoIssues(new LinearClient(), values.state), null, 2));
    return;
  }
  if (!id || positionals.length !== 2) throw new Error("Provide an action and one issue ID; use --help");
  const client = new LinearClient();
  let result: unknown;
  if (action === "get") result = await client.issue(id);
  else if (action === "start" || action === "done") result = await transition(client, id, action === "start" ? "started" : "completed", values.state);
  else {
    if (!values.file) throw new Error("--file is required");
    const content = await Bun.file(values.file).text();
    if (action === "plan") result = await publishPlan(client, await client.issue(id), content);
    else if (action === "todos" && values["plan-url"]) result = await publishTodos(client, id, content, values["plan-url"]);
    else if (action === "comment" && values.key) result = await publishComment(client, id, content, values.key, values.artifact);
    else throw new Error("Unknown action or missing --plan-url / --key; use --help");
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
