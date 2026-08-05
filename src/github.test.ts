import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const issues = {
    createComment: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    get: vi.fn(),
  };
  const octokit = { rest: { issues } };
  const getOctokit = vi.fn(() => octokit);
  const getInput = vi.fn();
  const context = { repo: { owner: "acme", repo: "widgets" } };
  return { issues, octokit, getOctokit, getInput, context };
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

describe("github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("comment", () => {
    it("creates a comment on the issue", async () => {
      h.issues.createComment.mockResolvedValue({ data: {} });
      await gh.comment(7, "a message");
      expect(h.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 7,
        body: "a message",
      });
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
});
