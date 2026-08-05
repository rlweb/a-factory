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
        case "vm-name-prefix":
          return "a-factory";
        case "vm-cpu":
          return "4";
        case "vm-disk":
          return "50G";
        case "vm-memory":
          return "8G";
        case "vm-tag":
          return "prod, staging";
        case "vm-env":
          return "FOO=bar\nBAZ=qux";
        default:
          return "";
      }
    });
    h.execFileSync.mockReturnValue("");
  });

  describe("vmName", () => {
    it("names VMs by issue number with the default prefix", () => {
      expect(exe.vmName(7)).toBe("a-factory-issue-7");
    });

    it("uses a custom prefix when vm-name-prefix is set", () => {
      h.getInput.mockImplementation((name: string) => (name === "vm-name-prefix" ? "factory" : ""));
      expect(exe.vmName(7)).toBe("factory-issue-7");
    });
  });

  describe("vmUrl", () => {
    it("points at the fixed opencode port", () => {
      expect(exe.vmUrl("a-factory-issue-7")).toBe("https://a-factory-issue-7.exe.xyz:4096");
    });
  });

  describe("createVm", () => {
    it("creates the VM with the configured image and starts opencode serve", () => {
      exe.createVm("a-factory-issue-7");

      expect(h.execFileSync).toHaveBeenCalledTimes(2);

      const [createBin, createArgs] = h.execFileSync.mock.calls[0] ?? [];
      expect(createBin).toBe("ssh");
      expect(createArgs.slice(0, 4)).toEqual(["-i", expect.any(String), "-o", "StrictHostKeyChecking=accept-new"]);
      expect(createArgs.slice(4)).toEqual([
        "exe.dev",
        "new",
        "--name",
        "a-factory-issue-7",
        "--command",
        "none",
        "--image",
        "ci-image",
        "--cpu",
        "4",
        "--disk",
        "50G",
        "--memory",
        "8G",
        "--tag",
        "prod",
        "--tag",
        "staging",
        "--env",
        "FOO=bar",
        "--env",
        "BAZ=qux",
        "--no-email",
      ]);

      const [runBin, runArgs] = h.execFileSync.mock.calls[1] ?? [];
      expect(runBin).toBe("ssh");
      expect(runArgs.slice(-2)[0]).toBe("a-factory-issue-7.exe.xyz");
      const command = runArgs.slice(-2)[1];
      expect(command).not.toContain("GITHUB_TOKEN");
      expect(command).not.toContain("export ");
      expect(command).toContain(`opencode serve --port ${exe.OPENCODE_PORT} --hostname 0.0.0.0`);
    });

    it("omits unset resource inputs and always passes --no-email", () => {
      h.getInput.mockImplementation((name: string) => (name === "ssh-exe-private-key" ? "auth" : ""));
      exe.createVm("a-factory-issue-7");
      const createArgs = h.execFileSync.mock.calls[0]?.[1] ?? [];
      expect(createArgs).not.toContain("--image");
      expect(createArgs).not.toContain("--cpu");
      expect(createArgs).not.toContain("--disk");
      expect(createArgs).not.toContain("--memory");
      expect(createArgs).not.toContain("--tag");
      expect(createArgs).not.toContain("--env");
      expect(createArgs).toContain("--no-email");
    });
  });

  describe("destroyVm", () => {
    it("removes the VM", () => {
      exe.destroyVm("a-factory-issue-7");
      const [bin, args] = h.execFileSync.mock.calls[0] ?? [];
      expect(bin).toBe("ssh");
      expect(args.slice(-3)).toEqual(["exe.dev", "rm", "a-factory-issue-7"]);
    });

    it("warns instead of throwing when the VM is already gone", () => {
      h.execFileSync.mockImplementationOnce(() => {
        throw new Error("not found");
      });
      expect(() => exe.destroyVm("a-factory-issue-7")).not.toThrow();
      expect(h.warning).toHaveBeenCalledWith(expect.stringContaining("a-factory-issue-7"));
    });
  });
});
