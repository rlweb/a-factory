import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const issues = {
    createComment: vi.fn(),
    listComments: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    get: vi.fn(),
  };
  const pulls = { create: vi.fn() };
  const repos = { get: vi.fn() };
  const octokit = { rest: { issues, pulls, repos } };
  const getOctokit = vi.fn(() => octokit);
  const getInput = vi.fn();
  const context = { repo: { owner: "acme", repo: "widgets" } };
  return { issues, pulls, repos, octokit, getOctokit, getInput, context };
});

vi.mock("@actions/core", () => ({
  getInput: h.getInput,
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}));
vi.mock("@actions/github", () => ({
  getOctokit: h.getOctokit,
  context: h.context,
}));

import * as gh from "./github.js";

function markerBody(vm: string, sessionId: string): string {
  const encoded = Buffer.from(JSON.stringify({ vm, sessionId })).toString("base64");
  return `${gh.BOT_MARKER_PREFIX}${encoded} -->`;
}

describe("github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isBotComment", () => {
    it("detects comments carrying a session marker", () => {
      expect(gh.isBotComment(markerBody("factory-issue-1", "s1"))).toBe(true);
      expect(gh.isBotComment("a real human question")).toBe(false);
      expect(gh.isBotComment("")).toBe(false);
    });
  });

  describe("botComment", () => {
    it("appends an embedded session marker to the body", async () => {
      h.issues.createComment.mockResolvedValue({ data: {} });
      await gh.botComment(7, "### Questions", { vm: "factory-issue-7", sessionId: "sess-1" });
      const body = (h.issues.createComment.mock.calls[0]?.[0] as { body: string }).body;
      expect(body).toContain("### Questions");
      expect(body).toContain(gh.BOT_MARKER_PREFIX);
      expect(body.trimEnd().endsWith("-->")).toBe(true);
    });
  });

  describe("latestMarker", () => {
    it("returns the most recent valid marker", async () => {
      h.issues.listComments.mockResolvedValue({
        data: [
          { body: "first reply, no marker" },
          { body: markerBody("factory-issue-1", "old") },
          { body: markerBody("factory-issue-1", "new") },
        ],
      });
      await expect(gh.latestMarker(1)).resolves.toEqual({
        vm: "factory-issue-1",
        sessionId: "new",
      });
    });

    it("returns null when no comment carries a marker", async () => {
      h.issues.listComments.mockResolvedValue({ data: [{ body: "hi" }, { body: "there" }] });
      await expect(gh.latestMarker(1)).resolves.toBeNull();
    });

    it("ignores malformed markers", async () => {
      h.issues.listComments.mockResolvedValue({
        data: [{ body: `<!-- a-factory-session:${Buffer.from("not-json").toString("base64")} -->` }],
      });
      await expect(gh.latestMarker(1)).resolves.toBeNull();
    });
  });

  describe("addLabel", () => {
    it("adds the label to the issue", async () => {
      h.issues.addLabels.mockResolvedValue({ data: [] });
      await gh.addLabel(7, "awaiting-answer");
      expect(h.issues.addLabels).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 7,
        labels: ["awaiting-answer"],
      });
    });
  });

  describe("removeLabel", () => {
    it("removes the label", async () => {
      h.issues.removeLabel.mockResolvedValue({ data: {} });
      await gh.removeLabel(7, "awaiting-answer");
      expect(h.issues.removeLabel).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 7,
        name: "awaiting-answer",
      });
    });

    it("swallows 404 (label already absent)", async () => {
      h.issues.removeLabel.mockRejectedValue({ status: 404 });
      await expect(gh.removeLabel(7, "awaiting-answer")).resolves.toBeUndefined();
    });

    it("rethrows other errors", async () => {
      h.issues.removeLabel.mockRejectedValue(new Error("rate limited"));
      await expect(gh.removeLabel(7, "awaiting-answer")).rejects.toThrow("rate limited");
    });
  });

  describe("hasLabel", () => {
    it("reports whether the issue carries the label", async () => {
      h.issues.get.mockResolvedValue({
        data: { labels: [{ name: "bug" }, { name: "awaiting-answer" }] },
      });
      await expect(gh.hasLabel(7, "awaiting-answer")).resolves.toBe(true);
      await expect(gh.hasLabel(7, "triaged")).resolves.toBe(false);
    });

    it("handles string-typed labels", async () => {
      h.issues.get.mockResolvedValue({ data: { labels: ["awaiting-answer"] } });
      await expect(gh.hasLabel(7, "awaiting-answer")).resolves.toBe(true);
    });
  });

  describe("openPullRequest", () => {
    it("creates a PR and returns its number", async () => {
      h.pulls.create.mockResolvedValue({ data: { number: 42 } });
      await expect(
        gh.openPullRequest("factory/issue-7", "main", "Fix it", "Closes #7"),
      ).resolves.toEqual({ number: 42 });
      expect(h.pulls.create).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        head: "factory/issue-7",
        base: "main",
        title: "Fix it",
        body: "Closes #7",
      });
    });
  });
});
