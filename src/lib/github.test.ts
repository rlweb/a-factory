import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock @actions/github so importing github.ts constructs a fake octokit. ---
const rest = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    removeLabel: vi.fn(async () => ({})),
    createComment: vi.fn(async (_p: { body: string }) => ({})),
    get: vi.fn(async () => ({ data: { labels: [] } })),
    listComments: vi.fn(),
  },
  pulls: {
    get: vi.fn(async () => ({ data: { node_id: "PR_node", number: 7 } })),
    listFiles: vi.fn(),
    create: vi.fn(async () => ({ data: { number: 7 } })),
  },
  reactions: { listForIssueComment: vi.fn() },
  repos: {
    createDispatchEvent: vi.fn(async () => ({})),
    getCollaboratorPermissionLevel: vi.fn(),
  },
};
const graphql = vi.fn(async (_query: string, _vars?: unknown) => ({}));
const paginate = Object.assign(
  vi.fn(async (fn: unknown, _params: unknown) => {
    // Route paginate() to the right underlying mock by identity.
    if (fn === rest.reactions.listForIssueComment) return reactionsData;
    if (fn === rest.issues.listComments) return commentsData;
    if (fn === rest.pulls.listFiles) return filesData;
    return [];
  }),
  {},
);

let reactionsData: unknown[] = [];
let commentsData: unknown[] = [];
let filesData: unknown[] = [];

vi.mock("@actions/github", () => ({
  getOctokit: () => ({ rest, graphql, paginate }),
  context: { repo: { owner: "o", repo: "r" } },
}));

process.env.GITHUB_TOKEN = "t";

const gh = await import("./github.js");

beforeEach(() => {
  vi.clearAllMocks();
  reactionsData = [];
  commentsData = [];
  filesData = [];
});

describe("dispatch helpers", () => {
  it("dispatchBuild fires event_type factory-build with the issue payload", async () => {
    await gh.dispatchBuild(123);
    expect(rest.repos.createDispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "factory-build",
        client_payload: { issue: 123 },
      }),
    );
  });

  it("dispatchEpic fires event_type factory-epic", async () => {
    await gh.dispatchEpic(9);
    expect(rest.repos.createDispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "factory-epic", client_payload: { issue: 9 } }),
    );
  });
});

describe("issueLabels", () => {
  it("normalises string and object labels to names", async () => {
    rest.issues.get.mockResolvedValueOnce({
      data: { labels: ["bug", { name: "ready" }, { name: undefined }] },
    } as never);
    expect(await gh.issueLabels(1)).toEqual(["bug", "ready"]);
  });
});

describe("botComment", () => {
  it("appends the marker so resume can distinguish agent comments", async () => {
    await gh.botComment(5, "please clarify", "<!-- factory-bot -->");
    const body = rest.issues.createComment.mock.calls[0][0].body as string;
    expect(body).toContain("please clarify");
    expect(body).toContain("<!-- factory-bot -->");
  });
});

describe("enableAutoMerge", () => {
  it("uses SQUASH merge method via graphql", async () => {
    await gh.enableAutoMerge(7);
    // graphql called with the PR node id; mutation string requests SQUASH.
    const [query, vars] = graphql.mock.calls[0];
    expect(query).toContain("SQUASH");
    expect(vars).toEqual({ id: "PR_node" });
  });
});

describe("commentHasMaintainerThumbsUp", () => {
  it("returns true when a write-access user reacted 👍", async () => {
    reactionsData = [{ content: "+1", user: { login: "maint" } }];
    rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "write" },
    });
    expect(await gh.commentHasMaintainerThumbsUp(1)).toBe(true);
  });

  it("returns false for a 👍 from a read-only user", async () => {
    reactionsData = [{ content: "+1", user: { login: "rando" } }];
    rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "read" },
    });
    expect(await gh.commentHasMaintainerThumbsUp(1)).toBe(false);
  });

  it("ignores non-👍 reactions", async () => {
    reactionsData = [{ content: "heart", user: { login: "maint" } }];
    expect(await gh.commentHasMaintainerThumbsUp(1)).toBe(false);
    expect(rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
  });
});

describe("prFiles", () => {
  it("returns filenames from the paginated listing", async () => {
    filesData = [{ filename: "a.ts" }, { filename: "b.ts" }];
    expect(await gh.prFiles(7)).toEqual(["a.ts", "b.ts"]);
  });
});
