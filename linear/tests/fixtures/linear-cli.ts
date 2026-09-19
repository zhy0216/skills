#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const path = process.env.LINEAR_TEST_STATE!;
if (!path) throw new Error("Test fixture requires LINEAR_TEST_STATE");
const state = await Bun.file(path).json();
const query = await new Response(Bun.stdin.stream()).text();
const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
const variables: Record<string, any> = {};
for (let i = 0; i < Bun.argv.length; i++) {
  if (Bun.argv[i] === "--variable") {
    const pair = Bun.argv[++i]!;
    const separator = pair.indexOf("=");
    variables[pair.slice(0, separator)] = JSON.parse(pair.slice(separator + 1));
  }
}
appendFileSync(path + ".calls", JSON.stringify({ operation, variables, args: Bun.argv.slice(2) }) + "\n");
if (state.errorsOn === operation) { console.log(JSON.stringify({ data: {}, errors: [{ message: "simulated GraphQL failure" }] })); process.exit(0); }
const issue = state.issues.find((i: any) => [i.id, i.identifier].includes(variables.id ?? variables.input?.issueId));
const page = (nodes: any[]) => {
  const start = Number(variables.after ?? 0);
  const size = state.pageSize ?? 1;
  const end = Math.min(start + size, nodes.length);
  return { nodes: nodes.slice(start, end), pageInfo: { hasNextPage: end < nodes.length, endCursor: state.stuckCursor ? "0" : String(end) } };
};
let data: any;
switch (operation) {
  case "LinearCreatorTeams": data = { teams: page(state.teams ?? [{ id: "team-id", key: "ENG", name: "Engineering" }]) }; break;
  case "LinearCreatorProjects": data = { projects: page(state.projects ?? []) }; break;
  case "LinearCreatorProjectTeams": data = { project: { teams: page((state.projects ?? []).find((p: any) => p.id === variables.id)?.teams ?? []) } }; break;
  case "LinearCreatorStates": data = { workflowStates: page(state.states ?? [{ id: "backlog", name: "Backlog", type: "backlog" }]) }; break;
  case "LinearCreatorIssues": data = { issues: page(state.issues.filter((i: any) => i.team.id === variables.filter.team.id.eq && (!variables.filter.project || i.project?.id === variables.filter.project.id.eq))) }; break;
  case "LinearCreatorCreate": {
    state.createAttempts = (state.createAttempts ?? 0) + 1;
    if (state.failCreateNumber === state.createAttempts || state.issues.some((i: any) => i.id === variables.input.id)) {
      await Bun.write(path, JSON.stringify(state));
      console.log(JSON.stringify({ data: {}, errors: [{ message: "simulated create rejection" }] })); process.exit(0);
    }
    const input = variables.input;
    const created = { ...input, identifier: `ENG-${state.issues.length + 1}`, url: `https://linear.test/issue/${input.id}`,
      state: (state.states ?? [{ id: "backlog", name: "Backlog", type: "backlog" }]).find((s: any) => s.id === input.stateId),
      team: (state.teams ?? [{ id: "team-id", key: "ENG", name: "Engineering" }]).find((t: any) => t.id === input.teamId),
      project: (state.projects ?? []).find((p: any) => p.id === input.projectId) ?? null,
      archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (state.wrongCreatedPriority) created.priority = 0;
    state.issues.push(created);
    if (state.loseCreateResponseOnce) {
      state.loseCreateResponseOnce = false;
      await Bun.write(path, JSON.stringify(state)); console.error("connection lost after create"); process.exit(7);
    }
    data = { issueCreate: { success: true, issue: created } }; break;
  }
  case "LinearCreatorRelations": data = { issue: { relations: page((state.relations ?? []).filter((r: any) => r.issue.id === variables.id)) } }; break;
  case "LinearCreatorRelation": {
    const input = variables.input;
    const relation = { id: input.id, type: input.type, issue: { id: input.issueId }, relatedIssue: { id: input.relatedIssueId } };
    state.relations ??= []; state.relations.push(relation);
    if (state.loseRelationResponseOnce) {
      state.loseRelationResponseOnce = false;
      await Bun.write(path, JSON.stringify(state)); console.error("connection lost after relation"); process.exit(7);
    }
    data = { issueRelationCreate: { success: true, issueRelation: relation } }; break;
  }
  case "LinearWatchTodos": data = { issues: page(state.issues) }; break;
  case "LinearWatchIssue": {
    state.reads ??= {};
    state.reads[variables.id] = (state.reads[variables.id] ?? 0) + 1;
    if (state.changeBeforeClaim === variables.id) issue.state = { id: "started", name: "In Progress", type: "started" };
    if (state.editOnSecondRead && state.reads[variables.id] === 2) { issue.description += "\nHuman edit"; issue.updatedAt += "-changed"; }
    data = { issue }; break;
  }
  case "LinearIssueComments": data = { issue: { comments: page(state.comments.filter((c: any) => c.issueId === variables.id)) } }; break;
  case "LinearIssueDocuments": data = { issue: { documents: page(state.documents.filter((d: any) => d.issueId === variables.id)) } }; break;
  case "LinearWorkflowStates": data = { workflowStates: page(state.states ?? [
    { id: "started", name: "In Progress", type: "started" }, { id: "review", name: "In Review", type: "started" }, { id: "completed", name: "Done", type: "completed" },
  ]) }; break;
  case "LinearIssueUpdate": {
    if (variables.input.stateId) {
      const states = state.states ?? [{ id: "started", name: "In Progress", type: "started" }, { id: "review", name: "In Review", type: "started" }, { id: "completed", name: "Done", type: "completed" }];
      issue.state = states.find((s: any) => s.id === variables.input.stateId);
    }
    if (variables.input.description !== undefined) issue.description = variables.input.description;
    issue.updatedAt += "-updated";
    data = { issueUpdate: { success: true, issue } }; break;
  }
  case "LinearPlanCreate": {
    const document = { ...variables.input, id: crypto.randomUUID(), url: `https://linear.test/document/${state.documents.length + 1}` };
    state.documents.push(document); data = { documentCreate: { success: true, document } }; break;
  }
  case "LinearPlanUpdate": {
    const document = state.documents.find((d: any) => d.id === variables.id);
    Object.assign(document, variables.input); data = { documentUpdate: { success: true, document } }; break;
  }
  case "LinearValidationComment": {
    const comment = { ...variables.input, id: crypto.randomUUID(), url: `https://linear.test/comment/${state.comments.length + 1}` };
    state.comments.push(comment); data = { commentCreate: { success: true, comment } }; break;
  }
  case "LinearValidationUpload": data = { fileUpload: { success: true, uploadFile: {
    uploadUrl: state.uploadUrl, assetUrl: "https://uploads.linear.test/artifact", headers: [{ key: "x-upload-test", value: "required" }],
  } } }; break;
  default: throw new Error(`Unhandled test operation ${operation}`);
}
await Bun.write(path, JSON.stringify(state));
console.log(JSON.stringify({ data }));

export {};
