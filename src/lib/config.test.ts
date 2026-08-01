import { describe, expect, it } from "vitest";
import { listEnv, numEnv, strEnv } from "./config.js";

// These helpers are the load-bearing part of the vars-based config: an unset GitHub
// Actions variable expands to "" (empty string), not undefined, so naive parsing
// (Number("") === 0, "" ?? x doesn't fall back) would silently zero out limits.

describe("numEnv", () => {
  const KEY = "FACTORY_TEST_NUM";
  const clear = () => delete process.env[KEY];

  it("returns the default when unset", () => {
    clear();
    expect(numEnv(KEY, 20)).toBe(20);
  });

  it("returns the default when EMPTY STRING (unset GitHub var)", () => {
    process.env[KEY] = "";
    expect(numEnv(KEY, 20)).toBe(20);
  });

  it("returns the default when non-numeric", () => {
    process.env[KEY] = "abc";
    expect(numEnv(KEY, 20)).toBe(20);
  });

  it("parses a valid number", () => {
    process.env[KEY] = "5";
    expect(numEnv(KEY, 20)).toBe(5);
  });

  it("accepts 0 as a real value, not a fallback trigger", () => {
    process.env[KEY] = "0";
    expect(numEnv(KEY, 20)).toBe(0);
  });
});

describe("strEnv", () => {
  const KEY = "FACTORY_TEST_STR";

  it("defaults when unset", () => {
    delete process.env[KEY];
    expect(strEnv(KEY, "def")).toBe("def");
  });

  it("defaults when empty string", () => {
    process.env[KEY] = "";
    expect(strEnv(KEY, "def")).toBe("def");
  });

  it("returns the set value", () => {
    process.env[KEY] = "custom";
    expect(strEnv(KEY, "def")).toBe("custom");
  });
});

describe("listEnv", () => {
  const KEY = "FACTORY_TEST_LIST";
  const def = ["a", "b"];

  it("defaults when unset", () => {
    delete process.env[KEY];
    expect(listEnv(KEY, def)).toEqual(["a", "b"]);
  });

  it("defaults when empty string", () => {
    process.env[KEY] = "";
    expect(listEnv(KEY, def)).toEqual(["a", "b"]);
  });

  it("splits comma-separated values and trims whitespace", () => {
    process.env[KEY] = "x, y ,z";
    expect(listEnv(KEY, def)).toEqual(["x", "y", "z"]);
  });

  it("drops blank segments from trailing/double commas", () => {
    process.env[KEY] = "x,,y,";
    expect(listEnv(KEY, def)).toEqual(["x", "y"]);
  });

  it("falls back to default if the value is only commas/whitespace", () => {
    process.env[KEY] = " , , ";
    expect(listEnv(KEY, def)).toEqual(["a", "b"]);
  });

  it("returns a copy, not the default array reference", () => {
    delete process.env[KEY];
    const out = listEnv(KEY, def);
    out.push("c");
    expect(def).toEqual(["a", "b"]); // default not mutated
  });
});
