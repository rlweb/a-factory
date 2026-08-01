import { describe, expect, it } from "vitest";
import { type GateConfig, gate, type Risk } from "./gate.js";

const cfg: GateConfig = {
  maxFilesChanged: 20,
  protectedPaths: [".github/**", "**/migrations/**", "src/auth/**", "package.json"],
};

/** A verdict that, with clean inputs, should auto-merge. Override per-case. */
function verdict(over: Partial<Risk> = {}): Risk {
  return {
    risk: "low",
    autoMerge: true,
    touchesAuth: false,
    touchesMigrations: false,
    touchesInfra: false,
    summary: "ok",
    ...over,
  };
}

describe("gate", () => {
  it("auto-merges a clean low-risk change", () => {
    const d = gate(verdict(), ["src/util.ts", "src/util.test.ts"], true, cfg);
    expect(d.autoMerge).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it("blocks when validation did not pass — even if everything else is clean", () => {
    const d = gate(verdict(), ["src/util.ts"], false, cfg);
    expect(d.autoMerge).toBe(false);
    expect(d.reasons).toContain("validation did not pass");
  });

  it.each([
    ["medium", "risk assessed as medium"],
    ["high", "risk assessed as high"],
  ] as const)("blocks on %s risk", (risk, reason) => {
    const d = gate(verdict({ risk }), ["a.ts"], true, cfg);
    expect(d.autoMerge).toBe(false);
    expect(d.reasons).toContain(reason);
  });

  it.each([
    ["touchesAuth", "touches auth"],
    ["touchesMigrations", "touches migrations"],
    ["touchesInfra", "touches infra"],
  ] as const)("blocks when %s is set", (flag, reason) => {
    const d = gate(verdict({ [flag]: true }), ["a.ts"], true, cfg);
    expect(d.autoMerge).toBe(false);
    expect(d.reasons).toContain(reason);
  });

  it("allows exactly at the file-count limit", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    expect(gate(verdict(), files, true, cfg).autoMerge).toBe(true);
  });

  it("blocks one over the file-count limit", () => {
    const files = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const d = gate(verdict(), files, true, cfg);
    expect(d.autoMerge).toBe(false);
    expect(d.reasons.some((r) => r.includes("files changed"))).toBe(true);
  });

  it.each([
    ".github/workflows/ci.yml",
    "db/migrations/001_init.sql",
    "src/auth/login.ts",
    "package.json",
  ])("blocks when a protected path is touched: %s", (path) => {
    const d = gate(verdict(), ["src/ok.ts", path], true, cfg);
    expect(d.autoMerge).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("protected paths:"))).toBe(true);
  });

  it("matches protected globs with dotfiles (dot: true)", () => {
    // .github is a dotfile dir — must still match ".github/**".
    const d = gate(verdict(), [".github/dependabot.yml"], true, cfg);
    expect(d.autoMerge).toBe(false);
  });

  it("accumulates multiple independent reasons", () => {
    const d = gate(
      verdict({ risk: "high", touchesAuth: true }),
      ["src/auth/x.ts", ...Array.from({ length: 25 }, (_, i) => `f${i}.ts`)],
      false,
      cfg,
    );
    // validation + risk + auth + file-count + protected-path = 5 distinct reasons
    expect(d.reasons.length).toBeGreaterThanOrEqual(5);
    expect(d.autoMerge).toBe(false);
  });

  it("ignores the agent's own autoMerge recommendation — policy decides", () => {
    // Agent says autoMerge:true but the change is high risk: gate still blocks.
    const d = gate(verdict({ risk: "high", autoMerge: true }), ["a.ts"], true, cfg);
    expect(d.autoMerge).toBe(false);
  });
});
