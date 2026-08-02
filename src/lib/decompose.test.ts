import { describe, expect, it } from "vitest";
import { parseDecomposeMode } from "./decompose.js";

// Bodies as GitHub actually renders an issue form: "### <label>", blank line, value.
const body = (decomposeValue: string | null) =>
  [
    "### Objective",
    "",
    "Ship the thing",
    "",
    "### Automation intent",
    "",
    "decompose this epic automatically",
    "",
    "### Decomposition intent",
    "",
    decomposeValue ?? "",
  ].join("\n");

const AUTO = "auto-create child tickets immediately";
const PROPOSE = "propose child tickets, wait for human approval";

describe("parseDecomposeMode", () => {
  it("reads auto from the epic's dropdown", () => {
    expect(parseDecomposeMode(body(AUTO), { repoDefault: "propose" })).toBe("auto");
  });

  it("reads propose from the epic's dropdown", () => {
    expect(parseDecomposeMode(body(PROPOSE), { repoDefault: "auto" })).toBe("propose");
  });

  it("lets the epic's dropdown override the repo-wide default in both directions", () => {
    expect(parseDecomposeMode(body(AUTO), { repoDefault: "propose" })).toBe("auto");
    expect(parseDecomposeMode(body(PROPOSE), { repoDefault: "auto" })).toBe("propose");
  });

  it("falls back to the repo-wide default when the field is absent", () => {
    expect(parseDecomposeMode("### Objective\n\nShip it", { repoDefault: "auto" })).toBe("auto");
    expect(parseDecomposeMode("### Objective\n\nShip it", { repoDefault: "propose" })).toBe(
      "propose",
    );
  });

  it("falls back when the field is present but blank", () => {
    expect(parseDecomposeMode(body(null), { repoDefault: "auto" })).toBe("auto");
  });

  it("falls back when the reporter left the dropdown unanswered", () => {
    expect(parseDecomposeMode(body("_No response_"), { repoDefault: "auto" })).toBe("auto");
  });

  it("does not swallow the following section's heading as the value", () => {
    // An empty trailing field must not read "### Automation intent" — which contains
    // "auto" — as its answer.
    const reordered = [
      "### Decomposition intent",
      "",
      "### Automation intent",
      "",
      "decompose this epic automatically",
    ].join("\n");
    expect(parseDecomposeMode(reordered, { repoDefault: "propose" })).toBe("propose");
  });

  it("defaults to propose when nothing is recognisable", () => {
    expect(parseDecomposeMode(body("something else entirely"), { repoDefault: "" })).toBe(
      "propose",
    );
    expect(parseDecomposeMode("", { repoDefault: "garbage" })).toBe("propose");
  });

  it("accepts a bare repo-wide default of auto", () => {
    expect(parseDecomposeMode("", { repoDefault: "auto" })).toBe("auto");
    expect(parseDecomposeMode("", { repoDefault: "AUTO" })).toBe("auto");
  });

  it("tolerates CRLF bodies and label casing", () => {
    expect(
      parseDecomposeMode("### decomposition intent\r\n\r\nauto-create child tickets", {
        repoDefault: "propose",
      }),
    ).toBe("auto");
  });

  it("is not confused by the phrase appearing in prose elsewhere", () => {
    const prose = [
      "### Objective",
      "",
      "I want auto-create behaviour eventually, but not yet.",
      "",
      "### Decomposition intent",
      "",
      PROPOSE,
    ].join("\n");
    expect(parseDecomposeMode(prose, { repoDefault: "auto" })).toBe("propose");
  });

  describe("dispatched mode (an approve comment)", () => {
    it("outranks a contradicting dropdown", () => {
      // The whole point: the reporter picked "propose" before seeing the breakdown, then
      // approved it. The approval has to win or approving does nothing.
      expect(parseDecomposeMode(body(PROPOSE), { dispatched: "auto" })).toBe("auto");
    });

    it("outranks a contradicting dropdown in the other direction too", () => {
      expect(parseDecomposeMode(body(AUTO), { dispatched: "propose" })).toBe("propose");
    });

    it("outranks the repo-wide default", () => {
      expect(parseDecomposeMode("", { dispatched: "auto", repoDefault: "propose" })).toBe("auto");
    });

    it("is ignored when empty, as on the labeled path", () => {
      // GitHub expands a missing client_payload field to "".
      expect(parseDecomposeMode(body(AUTO), { dispatched: "", repoDefault: "propose" })).toBe(
        "auto",
      );
      expect(parseDecomposeMode(body(PROPOSE), { dispatched: "", repoDefault: "auto" })).toBe(
        "propose",
      );
    });

    it("is ignored when unrecognisable, deferring to the dropdown", () => {
      expect(parseDecomposeMode(body(AUTO), { dispatched: "nonsense" })).toBe("auto");
    });
  });
});
