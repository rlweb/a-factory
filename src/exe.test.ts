import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const execFileSync = vi.fn();
  const core = {
    getInput: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  };
  return { execFileSync, core };
});

vi.mock("node:child_process", () => ({ execFileSync: h.execFileSync }));
vi.mock("@actions/core", () => h.core);

import * as exe from "./exe.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.core.getInput.mockImplementation((name: string) =>
    name === "ssh-exe-private-key" ? "auth" : "",
  );
});

describe("exe", () => {
  describe("vmName", () => {
    it("generates a VM name from the issue number", () => {
      h.core.getInput.mockImplementation((name: string) =>
        name === "vm-name-prefix" ? "a-factory" : "",
      );
      expect(exe.vmName(7)).toBe("a-factory-issue-7");
    });

    it("falls back to the default prefix when not configured", () => {
      expect(exe.vmName(7)).toBe("a-factory-issue-7");
    });
  });

  describe("vmUrl", () => {
    it("builds an HTTPS URL with the harness port", () => {
      expect(exe.vmUrl("factory-issue-7")).toBe(
        `https://factory-issue-7.exe.xyz:${exe.HARNESS_PORT}`,
      );
    });
  });

  describe("createVm", () => {
    it("passes all resource and tag inputs as ssh options", () => {
      h.core.getInput.mockImplementation((name: string) => {
        if (name === "ssh-exe-private-key") return "auth";
        if (name === "vm-cpu") return "8";
        if (name === "vm-disk") return "50G";
        if (name === "vm-memory") return "8G";
        if (name === "vm-tag") return "prod,ci";
        return "";
      });
      h.execFileSync.mockReturnValue("");
      exe.createVm("a-factory-issue-7");
      const calls = h.execFileSync.mock.calls as Array<Array<unknown>>;
      const newCmd = calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("exe.dev") && (c[1] as string[]).includes("new"),
      );
      expect(newCmd).toBeDefined();
      const args = newCmd![1] as string[];
      expect(args).toContain("--cpu");
      expect(args).toContain("8");
      expect(args).toContain("--disk");
      expect(args).toContain("50G");
      expect(args).toContain("--memory");
      expect(args).toContain("8G");
      expect(args).toContain("--tag");
      expect(args).toContain("prod");
      expect(args).toContain("--tag");
      expect(args).toContain("ci");
      expect(args).toContain("--no-email");
    });

    it("passes vm-env lines as --env flags", () => {
      h.core.getInput.mockImplementation((name: string) => {
        if (name === "ssh-exe-private-key") return "auth";
        if (name === "vm-env") return "OPENCODE_API_KEY=sk-abcdef";
        return "";
      });
      h.execFileSync.mockReturnValue("");
      exe.createVm("a-factory-issue-7");
      const calls = h.execFileSync.mock.calls;
      const newCmd = calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("exe.dev") && (c[1] as string[]).includes("new"),
      );
      expect(newCmd).toBeDefined();
      const args = newCmd![1] as string[];
      expect(args).toContain("--env");
      expect(args).toContain("OPENCODE_API_KEY=sk-abcdef");
    });

    it("does not SSH into the VM to start a process (systemd handles boot)", () => {
      h.execFileSync.mockReturnValue("");
      exe.createVm("a-factory-issue-7");
      const calls = h.execFileSync.mock.calls;
      const vmSsh = calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("a-factory-issue-7.exe.xyz"),
      );
      expect(vmSsh).toHaveLength(0);
    });

    it("omits unset resource inputs and always passes --no-email", () => {
      h.core.getInput.mockImplementation((name: string) =>
        name === "ssh-exe-private-key" ? "auth" : "",
      );
      h.execFileSync.mockReturnValue("");
      exe.createVm("a-factory-issue-7");
      const calls = h.execFileSync.mock.calls;
      const newCmd = calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("exe.dev") && (c[1] as string[]).includes("new"),
      );
      expect(newCmd).toBeDefined();
      const args = newCmd![1] as string[];
      expect(args).not.toContain("--cpu");
      expect(args).not.toContain("--disk");
      expect(args).not.toContain("--memory");
      expect(args).not.toContain("--tag");
      expect(args).toContain("--no-email");
    });
  });

  describe("destroyVm", () => {
    it("runs ssh exe.dev rm <name>", () => {
      h.execFileSync.mockReturnValue("");
      exe.destroyVm("a-factory-issue-7");
      expect(h.execFileSync).toHaveBeenCalledWith(
        "ssh",
        expect.arrayContaining(["exe.dev", "rm", "a-factory-issue-7"]),
        expect.any(Object),
      );
    });

    it("swallows non-zero exits (VM already gone)", () => {
      h.execFileSync.mockImplementation(() => {
        throw Object.assign(new Error("boom"), { status: 1 });
      });
      exe.destroyVm("a-factory-issue-7");
      expect(h.core.warning).toHaveBeenCalledWith(
        expect.stringContaining("already gone?"),
      );
    });
  });
});
