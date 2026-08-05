import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const context = { eventName: "", payload: {} as Record<string, unknown> };
  const exe = {
    vmName: vi.fn(),
    vmUrl: vi.fn(),
    createVm: vi.fn(),
    destroyVm: vi.fn(),
  };
  const issues = { createComment: vi.fn(), addLabels: vi.fn(), removeLabel: vi.fn(), get: vi.fn() };
  const gh = {
    addLabel: vi.fn(),
    comment: vi.fn(),
    hasLabel: vi.fn(),
    owner: "acme",
    removeLabel: vi.fn(),
    repo: "widgets",
    LABEL_AWAITING_ANSWER: "awaiting-answer",
  };
  const harness = { startSession: vi.fn(), resumeSession: vi.fn(), waitForServer: vi.fn() };
  const core = { getInput: vi.fn(), setFailed: vi.fn(), info: vi.fn(), warning: vi.fn() };
  return { context, exe, gh, harness, core };
});

vi.mock("@actions/core", () => h.core);
vi.mock("@actions/github", () => ({ getOctokit: vi.fn(), context: h.context }));
vi.mock("./exe.js", () => h.exe);
vi.mock("./github.js", () => h.gh);
vi.mock("./pi-harness.js", () => h.harness);

import { handleOutcome, onClose, onComment, onOpen } from "./main.js";

function setEvent(eventName: string, payload: Record<string, unknown>) {
  h.context.eventName = eventName;
  h.context.payload = payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  setEvent("", {});
  h.exe.vmUrl.mockReturnValue("https://factory-issue-7.exe.xyz:4096");
  h.exe.vmName.mockReturnValue("factory-issue-7");
  h.core.getInput.mockReturnValue("token");
});

describe("handleOutcome", () => {
  it("adds the awaiting-answer label and leaves VM running on question", async () => {
    await handleOutcome(7, "factory-issue-7", {
      status: "question",
      questions: ["which db?"],
    });
    expect(h.gh.addLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).not.toHaveBeenCalled();
  });

  it("logs and destroys VM on done", async () => {
    await handleOutcome(7, "factory-issue-7", {
      status: "done",
      branch: "factory/issue-7",
      prUrl: "https://github.com/acme/widgets/pull/42",
    });
    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });

  it("posts failure comment and destroys VM on failed", async () => {
    await handleOutcome(7, "factory-issue-7", {
      status: "failed",
      branch: "factory/issue-7",
      verify: "TypeScript error",
    });
    expect(h.gh.comment).toHaveBeenCalledWith(7, expect.stringContaining("TypeScript error"));
    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });
});

describe("onOpen", () => {
  it("creates VM, waits for harness, starts session, handles outcome", async () => {
    h.harness.waitForServer.mockResolvedValue(undefined);
    h.harness.startSession.mockResolvedValue({ status: "done", prUrl: "https://..." });

    await onOpen(7);

    expect(h.exe.createVm).toHaveBeenCalledWith("factory-issue-7");
    expect(h.harness.waitForServer).toHaveBeenCalledWith("https://factory-issue-7.exe.xyz:4096");
    expect(h.harness.startSession).toHaveBeenCalledWith(
      "https://factory-issue-7.exe.xyz:4096",
      "acme",
      "widgets",
      7,
    );
    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.exe.destroyVm).toHaveBeenCalledWith("factory-issue-7");
  });
});

describe("onComment", () => {
  it("resumes the session when the issue is awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.harness.resumeSession.mockResolvedValue({ status: "done", prUrl: "https://..." });

    await onComment(7);

    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.harness.resumeSession).toHaveBeenCalledWith(
      "https://factory-issue-7.exe.xyz:4096",
    );
    expect(h.exe.destroyVm).toHaveBeenCalled();
  });

  it("does nothing when the issue is not awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(false);
    await onComment(7);
    expect(h.harness.resumeSession).not.toHaveBeenCalled();
  });

  it("re-adds label and warns when harness is unreachable", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.harness.resumeSession.mockRejectedValue(new Error("ECONNREFUSED"));

    await onComment(7);

    expect(h.gh.addLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.core.warning).toHaveBeenCalled();
    expect(h.harness.resumeSession).toHaveBeenCalled();
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
    h.harness.waitForServer.mockResolvedValue(undefined);
    h.harness.startSession.mockResolvedValue({ status: "done" });

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
