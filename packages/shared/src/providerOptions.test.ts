import { describe, expect, it } from "vitest";

import {
  areProviderStartOptionsEqual,
  getProviderEnvironmentKey,
  normalizeProviderStartOptions,
} from "./providerOptions";

describe("normalizeProviderStartOptions (claudeAgent launchArgs)", () => {
  it("drops empty launchArgs records", () => {
    const normalized = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: {} },
    });
    expect(normalized).toBeUndefined();
  });

  it("sorts launchArgs keys so equal sets compare equal", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        launchArgs: { verbose: null, model: "opus" },
      },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        launchArgs: { model: "opus", verbose: null },
      },
    });
    expect(left).toEqual(right);
    expect(Object.keys(left?.claudeAgent?.launchArgs ?? {})).toEqual(["model", "verbose"]);
  });

  it("keeps launchArgs alongside other claudeAgent options", () => {
    const normalized = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: {
        binaryPath: "/usr/local/bin/claude",
        launchArgs: { model: "opus" },
      },
    });
    expect(normalized?.claudeAgent?.binaryPath).toBe("/usr/local/bin/claude");
    expect(normalized?.claudeAgent?.launchArgs).toEqual({ model: "opus" });
  });
});

describe("getProviderEnvironmentKey includes launchArgs", () => {
  it("distinguishes bindings whose launchArgs differ", () => {
    const withoutArgs = getProviderEnvironmentKey("claudeAgent", undefined);
    const withFlag = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null } },
    });
    const withDifferentFlag = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { debug: null } },
    });
    expect(withoutArgs).not.toEqual(withFlag);
    expect(withFlag).not.toEqual(withDifferentFlag);
  });

  it("is stable across equivalent launchArgs key orderings", () => {
    const a = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null, model: "opus" } },
    });
    const b = getProviderEnvironmentKey("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus", verbose: null } },
    });
    expect(a).toBe(b);
  });
});

describe("areProviderStartOptionsEqual with launchArgs", () => {
  it("treats differently-ordered launchArgs as equal after normalization", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { verbose: null, model: "opus" } },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus", verbose: null } },
    });
    expect(areProviderStartOptionsEqual(left, right)).toBe(true);
  });

  it("detects differing launchArgs values", () => {
    const left = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "opus" } },
    });
    const right = normalizeProviderStartOptions("claudeAgent", {
      claudeAgent: { launchArgs: { model: "sonnet" } },
    });
    expect(areProviderStartOptionsEqual(left, right)).toBe(false);
  });
});
