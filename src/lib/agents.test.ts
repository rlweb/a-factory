import { describe, expect, it } from "vitest";
import { AGENTS, implementAgentFor, loadSkillPrompt, mergeAgents } from "./agents.js";

describe("loadSkillPrompt", () => {
  it("reads the vendored skills and strips frontmatter", () => {
    for (const name of ["implement", "tdd", "diagnosing-bugs"]) {
      const prompt = loadSkillPrompt(name);
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt.startsWith("---")).toBe(false);
    }
  });
});

describe("AGENTS", () => {
  it("keeps read-only phases read-only", () => {
    for (const name of ["reviewer", "decomposer", "planner", "triager"]) {
      expect(AGENTS[name]?.permission?.edit).toBe("deny");
    }
  });

  it("marks tdd as a subagent for builder to delegate to", () => {
    expect(AGENTS.tdd?.mode).toBe("subagent");
  });

  it("prepends the harness preamble to every vendored skill prompt", () => {
    for (const name of ["builder", "tdd", "bugfixer"]) {
      expect(AGENTS[name]?.prompt).toContain("unattended inside a CI factory");
      expect(AGENTS[name]?.prompt).toContain("Never run git commit");
    }
  });

  it("gives the reviewer both axes and no interactive process", () => {
    const p = AGENTS.reviewer?.prompt ?? "";
    expect(p).toContain("Spec");
    expect(p).toContain("Standards");
    expect(p).toContain("Speculative Generality");
    expect(p).not.toMatch(/fixed point|sub-agent|setup-matt-pocock/i);
  });

  it("gives the decomposer the one-shot decomposition rules", () => {
    const p = AGENTS.decomposer?.prompt ?? "";
    expect(p).toContain("acceptance criteria");
    expect(p).toContain("independently shippable");
    expect(p).not.toMatch(/wayfinder:map|decision ticket/i);
  });
});

describe("mergeAgents", () => {
  it("returns the full roster when the repo defines no agents", () => {
    expect(Object.keys(mergeAgents(undefined))).toEqual(Object.keys(AGENTS));
  });

  it("drops baked agents the repo's opencode.json already defines", () => {
    const merged = mergeAgents({ builder: { prompt: "repo's own builder" } });
    expect(merged.builder).toBeUndefined();
    expect(merged.bugfixer).toBeDefined();
  });
});

describe("implementAgentFor", () => {
  it.each([
    [["bug", "triage"], "bugfixer"],
    [["ticket"], "builder"],
    [[], "builder"],
  ])("labels %j → %s", (labels, expected) => {
    expect(implementAgentFor(labels)).toBe(expected);
  });
});
