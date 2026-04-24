import { describe, expect, it } from "vitest";

import {
  canonicalizeClaudeLaunchArgs,
  filterReservedClaudeLaunchArgs,
  parseClaudeLaunchArgs,
} from "./cliArgs";

describe("parseClaudeLaunchArgs", () => {
  it("returns an empty record for empty input", () => {
    expect(parseClaudeLaunchArgs("")).toEqual({ ok: true, args: {} });
    expect(parseClaudeLaunchArgs(null)).toEqual({ ok: true, args: {} });
    expect(parseClaudeLaunchArgs(undefined)).toEqual({ ok: true, args: {} });
    expect(parseClaudeLaunchArgs("   ")).toEqual({ ok: true, args: {} });
  });

  it("parses flag-only arguments to null values", () => {
    expect(parseClaudeLaunchArgs("--verbose")).toEqual({
      ok: true,
      args: { verbose: null },
    });
  });

  it("parses --key=value form", () => {
    expect(parseClaudeLaunchArgs("--model=claude-opus-4-7")).toEqual({
      ok: true,
      args: { model: "claude-opus-4-7" },
    });
  });

  it("parses --key value form", () => {
    expect(parseClaudeLaunchArgs("--model claude-opus-4-7")).toEqual({
      ok: true,
      args: { model: "claude-opus-4-7" },
    });
  });

  it("preserves quoted values that contain spaces", () => {
    expect(parseClaudeLaunchArgs('--custom "hello world"')).toEqual({
      ok: true,
      args: { custom: "hello world" },
    });
    expect(parseClaudeLaunchArgs('--custom="hello world"')).toEqual({
      ok: true,
      args: { custom: "hello world" },
    });
  });

  it("mixes flags and key/value pairs", () => {
    expect(parseClaudeLaunchArgs("--verbose --model opus --debug")).toEqual({
      ok: true,
      args: { verbose: null, model: "opus", debug: null },
    });
  });

  it("allows -- followed by a flag to consume the flag rather than value", () => {
    expect(parseClaudeLaunchArgs("--model --verbose")).toEqual({
      ok: true,
      args: { model: null, verbose: null },
    });
  });

  it("rejects positional tokens without a -- prefix", () => {
    const result = parseClaudeLaunchArgs("claude --verbose");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("claude");
    }
  });

  it("rejects invalid flag names", () => {
    const result = parseClaudeLaunchArgs("--1bad");
    expect(result.ok).toBe(false);
  });

  it("later duplicates win", () => {
    expect(parseClaudeLaunchArgs("--model a --model b")).toEqual({
      ok: true,
      args: { model: "b" },
    });
  });

  it("preserves `=` inside values after the first equals", () => {
    expect(parseClaudeLaunchArgs("--a=b=c")).toEqual({
      ok: true,
      args: { a: "b=c" },
    });
  });

  it.each([
    "--output-format json",
    "--input-format=stream-json",
    "--permission-mode acceptEdits",
    "--session-id=abc",
    "--resume=xyz",
    "--mcp-config=./foo.json",
    "--add-dir /tmp",
    "--allow-dangerously-skip-permissions",
  ])("rejects reserved flag %s", (input) => {
    const result = parseClaudeLaunchArgs(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/managed by the app/);
    }
  });
});

describe("filterReservedClaudeLaunchArgs", () => {
  it("returns undefined for empty inputs", () => {
    expect(filterReservedClaudeLaunchArgs(undefined)).toBeUndefined();
    expect(filterReservedClaudeLaunchArgs(null)).toBeUndefined();
    expect(filterReservedClaudeLaunchArgs({})).toBeUndefined();
  });

  it("drops reserved keys and keeps the rest", () => {
    expect(
      filterReservedClaudeLaunchArgs({
        "output-format": "json",
        verbose: null,
        "session-id": "abc",
        debug: "true",
      }),
    ).toEqual({ verbose: null, debug: "true" });
  });

  it("returns undefined when only reserved keys are present", () => {
    expect(
      filterReservedClaudeLaunchArgs({ "output-format": "json", resume: "xyz" }),
    ).toBeUndefined();
  });
});

describe("canonicalizeClaudeLaunchArgs", () => {
  it("returns undefined for empty inputs", () => {
    expect(canonicalizeClaudeLaunchArgs(undefined)).toBeUndefined();
    expect(canonicalizeClaudeLaunchArgs(null)).toBeUndefined();
    expect(canonicalizeClaudeLaunchArgs({})).toBeUndefined();
  });

  it("sorts keys alphabetically so equal sets compare equal", () => {
    const left = canonicalizeClaudeLaunchArgs({ model: "opus", verbose: null });
    const right = canonicalizeClaudeLaunchArgs({ verbose: null, model: "opus" });
    expect(left).toEqual(right);
    expect(Object.keys(left!)).toEqual(["model", "verbose"]);
  });

  it("drops invalid flag names", () => {
    const out = canonicalizeClaudeLaunchArgs({ ok: "yes", "1bad": "nope" });
    expect(out).toEqual({ ok: "yes" });
  });

  it("drops reserved flag names", () => {
    const out = canonicalizeClaudeLaunchArgs({
      ok: "yes",
      "output-format": "json",
      "session-id": "abc",
    });
    expect(out).toEqual({ ok: "yes" });
  });
});
