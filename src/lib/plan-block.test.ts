import { describe, expect, it } from "vitest";
import {
  type Decomposition,
  decodePlanBlock,
  encodePlanBlock,
  MAX_COMMENT_CHARS,
  unavailablePlanBlock,
  withPlanBlock,
} from "./plan-block.js";

const plan = (n = 2, extra: Partial<Decomposition> = {}): Decomposition => ({
  subtasks: Array.from({ length: n }, (_, i) => ({
    title: `Ticket ${i}`,
    body: `Acceptance criteria for ${i}`,
    size: "M" as const,
    dependsOn: i === 0 ? [] : [i - 1],
  })),
  reasoning: "Vertical slice",
  ...extra,
});

describe("encodePlanBlock / decodePlanBlock", () => {
  it("round-trips a plan exactly", () => {
    const p = plan(3);
    expect(decodePlanBlock(encodePlanBlock(p))).toEqual(p);
  });

  it("round-trips a plan whose body contains --> ", () => {
    // The reason the payload is base64: raw JSON would close the HTML comment here and
    // corrupt both the block and the rendered comment.
    const p = plan(1);
    p.subtasks[0].body = "Migration --> then endpoints <!-- careful -->";
    const encoded = encodePlanBlock(p);
    expect(encoded.match(/-->/g)).toHaveLength(1);
    expect(decodePlanBlock(encoded)).toEqual(p);
  });

  it("round-trips unicode and newlines in bodies", () => {
    const p = plan(1);
    p.subtasks[0].body = "- [ ] don’t break “quotes”\n- [ ] ✅ emoji\n";
    expect(decodePlanBlock(encodePlanBlock(p))).toEqual(p);
  });

  it("finds the block when surrounded by comment prose", () => {
    const p = plan(2);
    const comment = `### Proposed breakdown\n\n1. **A** (M)\n\n${encodePlanBlock(p)}\n\n<!-- factory-bot -->`;
    expect(decodePlanBlock(comment)).toEqual(p);
  });

  it("returns the NEWEST block so a revised breakdown supersedes the first", () => {
    const first = plan(4);
    const second = plan(2);
    const thread = `round one\n${encodePlanBlock(first)}\nround two\n${encodePlanBlock(second)}`;
    expect(decodePlanBlock(thread)?.subtasks).toHaveLength(2);
  });

  // Never fall back to an older block: doing so would create tickets from a breakdown
  // that has since been revised, which is worse than re-decomposing.
  it("returns null when the newest block is corrupt, ignoring a valid older one", () => {
    const thread = `${encodePlanBlock(plan(3))}\n<!-- factory-plan:v1 bm90IGpzb24= -->`;
    expect(decodePlanBlock(thread)).toBeNull();
  });

  it("returns null when the newest block is the unavailable sentinel", () => {
    const thread = `${encodePlanBlock(plan(3))}\n${unavailablePlanBlock()}`;
    expect(decodePlanBlock(thread)).toBeNull();
  });

  it("returns null when there is no block", () => {
    expect(decodePlanBlock("### Proposed breakdown\n\n1. **A** (M)")).toBeNull();
    expect(decodePlanBlock("")).toBeNull();
  });

  it("returns null for a block whose payload is not a decomposition", () => {
    const notAPlan = Buffer.from(JSON.stringify({ nope: true }), "utf8").toString("base64");
    expect(decodePlanBlock(`<!-- factory-plan:v1 ${notAPlan} -->`)).toBeNull();
  });

  it("rejects a plan with a malformed subtask rather than half-creating tickets", () => {
    const bad = Buffer.from(
      JSON.stringify({ reasoning: "x", subtasks: [{ title: "A", size: "XL", dependsOn: [] }] }),
      "utf8",
    ).toString("base64");
    expect(decodePlanBlock(`<!-- factory-plan:v1 ${bad} -->`)).toBeNull();
  });

  it("ignores a block written by a future version", () => {
    const payload = Buffer.from(JSON.stringify(plan(1)), "utf8").toString("base64");
    expect(decodePlanBlock(`<!-- factory-plan:v2 ${payload} -->`)).toBeNull();
  });
});

describe("withPlanBlock", () => {
  it("appends the block and reports it persisted", () => {
    const { text, persisted } = withPlanBlock("### Proposed breakdown", plan(2));
    expect(persisted).toBe(true);
    expect(text.startsWith("### Proposed breakdown")).toBe(true);
    expect(decodePlanBlock(text)).toEqual(plan(2));
  });

  it("writes the unavailable sentinel when embedding would breach the comment limit", () => {
    // Better to post an un-replayable breakdown than to fail the comment entirely — but
    // the sentinel must still be written, so it supersedes any earlier block.
    const { text, persisted } = withPlanBlock("head", plan(2), 20);
    expect(persisted).toBe(false);
    expect(text.startsWith("head")).toBe(true);
    expect(decodePlanBlock(text)).toBeNull();
  });

  it("sentinel supersedes an earlier persisted plan in the same thread", () => {
    const round1 = withPlanBlock("first", plan(4)).text;
    const round2 = withPlanBlock("second", plan(2), 20).text;
    expect(decodePlanBlock(`${round1}\n${round2}`)).toBeNull();
  });

  it("defaults to GitHub's real comment ceiling", () => {
    const huge = plan(1);
    huge.subtasks[0].body = "x".repeat(MAX_COMMENT_CHARS);
    expect(withPlanBlock("head", huge).persisted).toBe(false);
  });
});
