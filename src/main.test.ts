import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const context = { eventName: "", payload: {} as Record<string, unknown> };
  const exe = {
    vmName: vi.fn(),
    createVm: vi.fn(),
    destroyVm: vi.fn(),
  };
  const gh = {
    addLabel: vi.fn(),
    hasLabel: vi.fn(),
    owner: "acme",
    removeLabel: vi.fn(),
    repo: "widgets",
    LABEL_AWAITING_ANSWER: "awaiting-answer",
  };
  const harness = { resumeSession: vi.fn(), startSession: vi.fn(), waitForServer: vi.fn() };
  const core = { getInput: vi.fn(), setFailed: vi.fn(), info: vi.fn(), warning: vi.fn() };
  return { context, exe, gh, harness, core };
});

vi.mock("@actions/core", () => h.core);
vi.mock("@actions/github", () => ({ getOctokit: vi.fn(), context: h.context }));
vi.mock("./exe.js", () => h.exe);
vi.mock("./github.js", () => h.gh);
vi.mock("./pi-harness.js", () => h.harness);

import { onClose, onComment, onOpen } from "./main.js";

function setEvent(eventName: string, payload: Record<string, unknown>) {
  h.context.eventName = eventName;
  h.context.payload = payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  setEvent("", {});
  h.exe.vmName.mockReturnValue("factory-issue-7");
  h.core.getInput.mockReturnValue("token");
});

describe("onOpen", () => {
  it("creates the VM, waits for the harness, and POSTs to start the session", async () => {
    h.harness.waitForServer.mockReturnValue(undefined);
    h.harness.startSession.mockReturnValue({ status: "started" });

    await onOpen(7);

    expect(h.exe.createVm).toHaveBeenCalledWith("factory-issue-7");
    expect(h.harness.waitForServer).toHaveBeenCalledWith("factory-issue-7");
    expect(h.harness.startSession).toHaveBeenCalledWith(
      "factory-issue-7",
      "acme",
      "widgets",
      7,
    );
    expect(h.exe.destroyVm).not.toHaveBeenCalled();
    expect(h.harness.resumeSession).not.toHaveBeenCalled();
  });
});

describe("onComment", () => {
  it("resumes the harness fire-and-forget when awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(true);

    await onComment(7);

    expect(h.gh.removeLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.harness.resumeSession).toHaveBeenCalledWith("factory-issue-7");
  });

  it("does nothing when the issue is not awaiting an answer", async () => {
    h.gh.hasLabel.mockResolvedValue(false);
    await onComment(7);
    expect(h.harness.resumeSession).not.toHaveBeenCalled();
    expect(h.gh.removeLabel).not.toHaveBeenCalled();
  });

  it("re-adds the label and warns when the resume fails", async () => {
    h.gh.hasLabel.mockResolvedValue(true);
    h.harness.resumeSession.mockImplementation(() => {
      throw new Error("ssh failed");
    });

    await onComment(7);

    expect(h.gh.addLabel).toHaveBeenCalledWith(7, "awaiting-answer");
    expect(h.core.warning).toHaveBeenCalledWith(
      expect.stringContaining("factory-issue-7"),
    );
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
