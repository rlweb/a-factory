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

describe("parseDecomposeMode", () => {
  it("reads auto from the epic's dropdown", () => {
    expect(parseDecomposeMode(body("auto-create child tickets immediately"), "propose")).toBe(
      "auto",
    );
  });

  it("reads propose from the epic's dropdown", () => {
    expect(parseDecomposeMode(body("propose child tickets, wait for human approval"), "auto")).toBe(
      "propose",
    );
  });

  it("lets the epic's dropdown override the repo-wide default in both directions", () => {
    expect(parseDecomposeMode(body("auto-create child tickets immediately"), "propose")).toBe(
      "auto",
    );
    expect(parseDecomposeMode(body("propose child tickets, wait for human approval"), "auto")).toBe(
      "propose",
    );
  });

  it("falls back to the repo-wide default when the field is absent", () => {
    expect(parseDecomposeMode("### Objective\n\nShip the thing", "auto")).toBe("auto");
    expect(parseDecomposeMode("### Objective\n\nShip the thing", "propose")).toBe("propose");
  });

  it("falls back when the field is present but blank", () => {
    expect(parseDecomposeMode(body(null), "auto")).toBe("auto");
  });

  it("falls back when the reporter left the dropdown unanswered", () => {
    expect(parseDecomposeMode(body("_No response_"), "auto")).toBe("auto");
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
    expect(parseDecomposeMode(reordered, "propose")).toBe("propose");
  });

  it("defaults to propose when neither the field nor the default is recognisable", () => {
    expect(parseDecomposeMode(body("something else entirely"), "")).toBe("propose");
    expect(parseDecomposeMode("", "garbage")).toBe("propose");
  });

  it("accepts a bare repo-wide default of auto", () => {
    expect(parseDecomposeMode("", "auto")).toBe("auto");
    expect(parseDecomposeMode("", "AUTO")).toBe("auto");
  });

  it("tolerates CRLF bodies and label casing", () => {
    expect(
      parseDecomposeMode("### decomposition intent\r\n\r\nauto-create child tickets", "propose"),
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
      "propose child tickets, wait for human approval",
    ].join("\n");
    expect(parseDecomposeMode(prose, "auto")).toBe("propose");
  });
});
