import { createHash } from "node:crypto";

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  updatedAt: string;
  createdAt: string;
  priority: number;
  archivedAt: string | null;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
};

export const ISSUE_FIELDS = `id identifier title url description updatedAt createdAt priority archivedAt
  state { id name type } team { id key name } project { id name }`;

export async function command(cmd: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (timedOut || code !== 0) throw new Error(`${cmd[0]} ${timedOut ? "timed out" : `exited ${code}`}: ${stderr.trim().slice(0, 4000)}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

export class LinearClient {
  constructor(readonly binary = process.env.LINEAR_CLI_BIN || "linear-cli", readonly profile = process.env.LINEAR_CLI_PROFILE) {}

  async request<T = any>(query: string, variables: Record<string, unknown> = {}, mutation = false): Promise<T> {
    const args = [this.binary, "--output", "json", "--quiet", "--no-pager", "--no-cache"];
    if (this.profile) args.push("--profile", this.profile);
    args.push("api", mutation ? "mutate" : "query", "-");
    // Pass data as argv and the query over stdin. No shell interpolation, including Markdown.
    for (const [key, value] of Object.entries(variables)) args.push("--variable", `${key}=${JSON.stringify(value)}`);
    const result = JSON.parse(await command(args, { input: query }));
    if (result.errors?.length) throw new Error(`Linear: ${JSON.stringify(result.errors)}`);
    if (!result.data || typeof result.data !== "object") throw new Error("linear-cli returned no GraphQL data");
    return result.data as T;
  }

  async pages<T>(query: string, variables: Record<string, unknown>, select: (data: any) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }): Promise<T[]> {
    const nodes: T[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    do {
      const page = select(await this.request(query, { ...variables, after }));
      if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") throw new Error("Invalid Linear connection response");
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return nodes;
      after = page.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("Linear pagination did not advance");
      cursors.add(after);
    } while (true);
  }

  async issue(id: string): Promise<Issue> {
    const data = await this.request(`query LinearWatchIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
    if (!data.issue?.id || !data.issue?.state?.type) throw new Error(`Issue not found: ${id}`);
    return data.issue;
  }

  async todoIssues(): Promise<Issue[]> {
    return this.pages(`query LinearWatchTodos($after: String) {
      issues(first: 100, after: $after, filter: { state: { type: { eq: "unstarted" } } }) {
        nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
      }
    }`, {}, (data) => data.issues);
  }

  async comments(id: string): Promise<{ id: string; body: string; url: string }[]> {
    return this.pages(`query LinearIssueComments($id: String!, $after: String) {
      issue(id: $id) { comments(first: 100, after: $after) { nodes { id body url } pageInfo { hasNextPage endCursor } } }
    }`, { id }, (data) => data.issue.comments);
  }

  async documents(id: string): Promise<{ id: string; title: string; content: string | null; url: string }[]> {
    return this.pages(`query LinearIssueDocuments($id: String!, $after: String) {
      issue(id: $id) { documents(first: 100, after: $after) { nodes { id title content url } pageInfo { hasNextPage endCursor } } }
    }`, { id }, (data) => data.issue.documents);
  }

  async updateIssue(id: string, input: Record<string, unknown>) {
    const data = await this.request(`mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`, { id, input }, true);
    if (!data.issueUpdate?.success) throw new Error("Linear did not confirm issueUpdate");
    return data.issueUpdate.issue as Issue;
  }
}

export const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
