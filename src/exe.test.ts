import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const getInput = vi.fn();
  const info = vi.fn();
  const warning = vi.fn();
  const execFileSync = vi.fn();
  return { getInput, info, warning, execFileSync };
});

vi.mock("node:child_process", () => ({ execFileSync: h.execFileSync }));
vi.mock("@actions/core", () => ({
  getInput: h.getInput,
  info: h.info,
  warning: h.warning,
  setFailed: vi.fn(),
}));

import * as exe from "./exe.js";

describe("exe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getInput.mockImplementation((name: string) => {
      switch (name) {
        case "ssh-exe-private-key":
          return "auth-secret\n";
        case "vm-image":
          return "ci-image";
        default:
          return "";
      }
    });
    h.execFileSync.mockReturnValue("");
  });

  describe("vmName", () => {
    it("names VMs by issue number", () => {
      expect(exe.vmName(7)).toBe("factory-issue-7");
    });
  });

  describe("vmUrl", () => {
    it("points at the fixed opencode port", () => {
      expect(exe.vmUrl("factory-issue-7")).toBe("https://factory-issue-7.exe.xyz:4096");
    });
  });

  describe("createVm", () => {
    it("creates the VM with the configured image and starts opencode serve", () => {
      exe.createVm("factory-issue-7", { GITHUB_TOKEN: "tok", OPENCODE_API_KEY: "key" });

      expect(h.execFileSync).toHaveBeenCalledTimes(2);

      const [createBin, createArgs] = h.execFileSync.mock.calls[0] ?? [];
      expect(createBin).toBe("ssh");
      expect(createArgs.slice(0, 4)).toEqual(["-i", expect.any(String), "-o", "StrictHostKeyChecking=accept-new"]);
      expect(createArgs.slice(4)).toEqual([
        "exe.dev",
        "new",
        "--name",
        "factory-issue-7",
        "--command",
        "none",
        "--image",
        "ci-image",
      ]);

      const [runBin, runArgs] = h.execFileSync.mock.calls[1] ?? [];
      expect(runBin).toBe("ssh");
      expect(runArgs.slice(-2)[0]).toBe("factory-issue-7.exe.xyz");
      const command = runArgs.slice(-2)[1];
      expect(command).toContain("export GITHUB_TOKEN=\"tok\";");
      expect(command).toContain("export OPENCODE_API_KEY=\"key\";");
      expect(command).toContain(`opencode serve --port ${exe.OPENCODE_PORT} --hostname 0.0.0.0`);
    });

    it("omits --image when no vm-image input is set", () => {
      h.getInput.mockImplementation((name: string) => (name === "ssh-exe-private-key" ? "auth" : ""));
      exe.createVm("factory-issue-7", {});
      const createArgs = h.execFileSync.mock.calls[0]?.[1] ?? [];
      expect(createArgs).not.toContain("--image");
    });
  });

  describe("destroyVm", () => {
    it("removes the VM", () => {
      exe.destroyVm("factory-issue-7");
      const [bin, args] = h.execFileSync.mock.calls[0] ?? [];
      expect(bin).toBe("ssh");
      expect(args.slice(-3)).toEqual(["exe.dev", "rm", "factory-issue-7"]);
    });

    it("warns instead of throwing when the VM is already gone", () => {
      h.execFileSync.mockImplementationOnce(() => {
        throw new Error("not found");
      });
      expect(() => exe.destroyVm("factory-issue-7")).not.toThrow();
      expect(h.warning).toHaveBeenCalledWith(expect.stringContaining("factory-issue-7"));
    });
  });
});
