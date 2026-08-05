import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const context = { eventName: "", payload: {} as Record<string, unknown> };
  const exe = {
    vmName: vi.fn(),
    vmUrl: vi.fn(),
    createVm: vi.fn(),
    destroyVm: vi.fn(),
  };
  const issues = { get: vi.fn(), createComment: vi.fn(), listComments: vi.fn(), addLabels: vi.fn(), removeLabel: vi.fn() };
  const pulls = { create: vi.fn() };
  const repos = { get: vi.fn() };
  const gh = {
    addLabel: vi.fn(),
    hasLabel: vi.fn(),
    isBotComment: vi.fn(),
    latestMarker: vi.fn(),
    octokit: { rest: { issues, pulls, repos } },
    openPullRequest: vi.fn(),
    owner: "acme",
    removeLabel: vi.fn(),
    repo: "widgets",
    botComment: vi.fn(),
    LABEL_AWAITING_ANSWER: "awaiting-answer",
  };
  const oc = { connect: vi.fn(), createSession: vi.fn(), promptJSON: vi.fn() };
  const core = { getInput: vi.fn(), setFailed: vi.fn(), info: vi.fn(), warning: vi.fn() };
  return { context, exe, gh, oc, core };
});

vi.mock("@actions/core", () => h.core);
vi.mock("@actions/github", () => ({ getOctokit: vi.fn(), context: h.context }));
vi.mock("./exe.js", () => h.exe);
vi.mock("./github.js", () => h.gh);
vi.mock("./opencode.js", () => h.oc);

import {
  continuePrompt,
  handleOutcome,
  implementPrompt,
  onClose,
  onComment,
  onOpen,
  waitForServer,
} from "./main.js";

function setEvent(eventName: string, payload: Record<string, unknown>) {
  h.context.eventName = eventName;
  h.context.payload = payload;
}

function doneOutcome() {
  h.gh.octokit.rest.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
  h.gh.openPullRequest.mockResolvedValue({ number: 42 });
}

beforeEach(() => {
  vi.clearAllMocks();
  setEvent("", {});
  h.exe.vmUrl.mockReturnValue("https://factory-issue-7.exe.xyz:4096");
  h.exe.vmName.mockReturnValue("factory-issue-7");
  h.oc.connect.mockReturnValue({ session: {} });
  h.oc.createSession.mockResolvedValue("sess-1");
  h.core.getInput.mockReturnValue("token");
  vi.unstubAllGlobals();
});

describe("prompt builders", () => {
  it("builds the issue implementation prompt with branch and issue details", () => {
    const prompt = implementPrompt(7, "Fix the bug", "body text");
    expect(prompt).toContain("ISSUE #7: Fix the bug");
    expect(prompt).toContain("body text");
    expect(prompt).toContain('branch "factory/issue-7"');
    expect(prompt).toContain("acme/widgets");
  });

  it("builds the continue prompt embedding the user reply", () => {
    expect(continuePrompt("please explain more")).toContain("please explain more");
  });
});

describe("waitForServer", () => {
  it("resolves once the server answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(waitForServer("http://vm:4096", 50, 5)).resolves.toBeUndefined();
  });

  it("throws after the timeout budget is spent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(waitForServer("http://vm:4096", 40, 5)).rejects.toThrow("never came up");
  });
});

describe("handleOutcome", () => {
  it("posts questions, marks awaiting-answer, and leaves the VM running", async () => {
    await handleOutcome(7, "factory-issue-7", "sess-1", {
      status: "question",
      questions: ["which db?", "which lang?"],
    });
    const body = h.gh.botComment.mock.calls[0]?.[1] as string;
    expect(body).toContain("which db?");
    expect(h.gh.botComment).toHaveBeenCalledWith(7, body, { vm: "factory-issue-7", sessionId: "sess-1" });
    expect(h.gh.addLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).not.toHaveBeenCalled();
  });

  it("opens a PR and destroys the VM on completion", async () => {
    doneOutcome();
    await handleOutcome(7, "factory-issue-7", "sess-1", {
      status: "done",
      branch: "factory/issue-7",
      prTitle: "Fix the bug",
      prSummary: "Summary here",
    });
    expect(h.gh.openPullRequest).toHaveBeenCalledWith(
      "factory/issue-7",
      "main",
      "Fix the bug",
      "Summary here\n\nCloses #7",
    );
    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });
});

describe("onOpen", () => {
  it("spins up the VM, starts a session, and runs the implementation prompt", async () => {
    doneOutcome();
    h.gh.octokit.rest.issues.get.mockResolvedValue({ data: { title: "Fix the bug", body: "details" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    h.oc.promptJSON.mockResolvedValue({ status: "done" });

    await onOpen(7);

    expect(h.exe.createVm).toHaveBeenCalledWith("factory-issue-7", {
      GITHUB_TOKEN: "token",
      OPENCODE_API_KEY: "token",
    });
    expect(h.oc.connect).toHaveBeenCalledWith("https://factory-issue-7.exe.xyz:4096");
    expect(h.oc.createSession).toHaveBeenCalledWith(expect.anything(), "issue #7");
    expect(h.oc.promptJSON).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.stringContaining("ISSUE #7"),
      expect.any(Object),
    );
    expect(h.gh.openPullRequest).toHaveBeenCalled();
  });
});

describe("onComment", () => {
  beforeEach(() => {
    setEvent("issue_comment", {
      action: "created",
      issue: { number: 7 },
      comment: { body: "try this approach" },
    });
  });

  it("resumes the session when the issue is awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.gh.isBotComment.mockReturnValue(false);
    h.gh.latestMarker.mockResolvedValue({ vm: "factory-issue-7", sessionId: "sess-1" });
    doneOutcome();
    h.oc.promptJSON.mockResolvedValue({ status: "done" });

    await onComment(7, "try this approach");

    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.oc.promptJSON).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.stringContaining("try this approach"),
      expect.any(Object),
    );
    expect(h.gh.openPullRequest).toHaveBeenCalled();
  });

  it("does nothing when the issue is not awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(false);
    await onComment(7, "try this approach");
    expect(h.gh.latestMarker).not.toHaveBeenCalled();
    expect(h.oc.promptJSON).not.toHaveBeenCalled();
  });

  it("ignores the bot's own comments", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.gh.isBotComment.mockReturnValue(true);
    await onComment(7, "we are bots");
    expect(h.gh.latestMarker).not.toHaveBeenCalled();
    expect(h.oc.promptJSON).not.toHaveBeenCalled();
  });

  it("warns and bails when awaiting-answer but no marker exists", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.gh.isBotComment.mockReturnValue(false);
    h.gh.latestMarker.mockResolvedValue(null);
    await onComment(7, "hello");
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining("no session marker"));
    expect(h.gh.removeLabel).not.toHaveBeenCalled();
    expect(h.oc.promptJSON).not.toHaveBeenCalled();
  });
});

describe("onClose", () => {
  it("destroys the VM for the issue", async () => {
    await onClose(7);
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });
});

describe("run dispatch", () => {
  it("handles an issue opened event", async () => {
    setEvent("issues", { action: "opened", issue: { number: 7 } });
    doneOutcome();
    h.gh.octokit.rest.issues.get.mockResolvedValue({ data: { title: "t", body: "b" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    h.oc.promptJSON.mockResolvedValue({ status: "done" });

    await expect(import("./main.js").then((m) => m.run())).resolves.toBeUndefined();
    expect(h.exe.createVm).toHaveBeenCalled();
  });

  it("handles an issue closed event", async () => {
    setEvent("issues", { action: "closed", issue: { number: 7 } });
    await expect(import("./main.js").then((m) => m.run())).resolves.toBeUndefined();
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });

  it("ignores unknown actions and events", async () => {
    setEvent("issues", { action: "labeled", issue: { number: 7 } });
    await expect(import("./main.js").then((m) => m.run())).resolves.toBeUndefined();
    setEvent("push", {});
    await expect(import("./main.js").then((m) => m.run())).resolves.toBeUndefined();
    expect(h.exe.createVm).not.toHaveBeenCalled();
    expect(h.exe.destroyVm).not.toHaveBeenCalled();
  });

  it("skips pull request comments", async () => {
    setEvent("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "nice" },
    });
    await expect(import("./main.js").then((m) => m.run())).resolves.toBeUndefined();
    expect(h.gh.hasLabel).not.toHaveBeenCalled();
  });
});
