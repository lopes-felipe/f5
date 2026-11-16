import { describe, expect, it } from "vitest";

import {
  mcpAggregateStatus,
  mcpServerIconKind,
  mcpServerTint,
  mcpToolNameServerKey,
  resolveMcpServerLabel,
  summarizeMcpResult,
} from "./mcpServerDisplay";

const noStatusNames = new Map<string, string>();

describe("resolveMcpServerLabel", () => {
  it("names F5's own servers", () => {
    expect(resolveMcpServerLabel("f5_thread", noStatusNames)).toBe("F5 threads");
    expect(resolveMcpServerLabel("__f5_preview", noStatusNames)).toBe("F5 preview");
    expect(resolveMcpServerLabel("f5_computer", noStatusNames)).toBe("F5 computer");
  });

  it("prefers the real name from status events, without the claude.ai prefix", () => {
    const realName = "claude.ai Claude Docs";
    const statusNames = new Map([[mcpToolNameServerKey(realName), realName]]);
    expect(mcpToolNameServerKey(realName)).toBe("claude_ai_Claude_Docs");
    expect(resolveMcpServerLabel("claude_ai_Claude_Docs", statusNames)).toBe("Claude Docs");
    const custom = new Map([[mcpToolNameServerKey("my.server"), "my.server"]]);
    expect(resolveMcpServerLabel("my_server", custom)).toBe("My.server");
    // Codex keeps the real name in the tool payload; it still finds its status entry.
    expect(resolveMcpServerLabel("my.server", custom)).toBe("My.server");
  });

  it("reads the same with or without the status event", () => {
    const statusNames = new Map([["github", "github"]]);
    expect(resolveMcpServerLabel("github", statusNames)).toBe(
      resolveMcpServerLabel("github", noStatusNames),
    );
  });

  it("falls back to cleaning up the flattened name", () => {
    expect(resolveMcpServerLabel("claude_ai_Claude_Docs", noStatusNames)).toBe("Claude Docs");
    expect(resolveMcpServerLabel("filesystem", noStatusNames)).toBe("Filesystem");
    expect(resolveMcpServerLabel("chrome_devtools", noStatusNames)).toBe("Chrome devtools");
  });
});

describe("mcpServerIconKind", () => {
  it("prefers a brand, then claude.ai connectors, then F5, then a monogram", () => {
    expect(mcpServerIconKind("claude_ai_Linear", "Linear")).toBe("linear");
    expect(mcpServerIconKind("github", "Github")).toBe("github");
    expect(mcpServerIconKind("claude_ai_Claude_Docs", "Claude Docs")).toBe("claude");
    expect(mcpServerIconKind("f5_thread", "F5 threads")).toBe("f5");
    expect(mcpServerIconKind("filesystem", "Filesystem")).toBe("monogram");
  });

  it("matches brands as whole words only", () => {
    expect(mcpServerIconKind("my-github-mirror", "My-github-mirror")).toBe("github");
    expect(mcpServerIconKind("linear_algebra", "Linear algebra")).toBe("linear");
    expect(mcpServerIconKind("nonlinear_solver", "Nonlinear solver")).toBe("monogram");
    expect(mcpServerIconKind("slackware_pkgs", "Slackware pkgs")).toBe("monogram");
    expect(mcpServerIconKind("githubber", "Githubber")).toBe("monogram");
  });
});

describe("mcpServerTint", () => {
  it("is stable and within the chart palette", () => {
    expect(mcpServerTint("filesystem")).toBe(mcpServerTint("filesystem"));
    for (const name of ["a", "filesystem", "chrome_devtools", "x".repeat(200)]) {
      expect(mcpServerTint(name)).toBeGreaterThanOrEqual(1);
      expect(mcpServerTint(name)).toBeLessThanOrEqual(6);
    }
  });
});

describe("summarizeMcpResult", () => {
  const parse = (text: string) => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const pairs = (input: Record<string, unknown>) =>
    Object.entries(input)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(" · ") || null;

  it("summarizes JSON objects as pairs", () => {
    expect(summarizeMcpResult('{"reason":"self"}', parse, pairs)).toBe('reason: "self"');
  });

  it("uses the first non-empty line of text results", () => {
    expect(summarizeMcpResult("\n\n  Docs   usage guide\nsecond", parse, pairs)).toBe(
      "Docs usage guide",
    );
  });

  it("caps long lines and ignores empty results", () => {
    const preview = summarizeMcpResult("x".repeat(500), parse, pairs);
    expect(preview?.length).toBe(160);
    expect(preview?.endsWith("…")).toBe(true);
    expect(summarizeMcpResult("   ", parse, pairs)).toBeNull();
    expect(summarizeMcpResult(undefined, parse, pairs)).toBeNull();
  });
});

describe("mcpAggregateStatus", () => {
  it("lets running win, then failures, then lost completions, then all-declined", () => {
    expect(mcpAggregateStatus(["completed", "failed", "running"])).toBe("running");
    expect(mcpAggregateStatus(["interrupted", "failed", "declined"])).toBe("failed");
    expect(mcpAggregateStatus(["completed", "interrupted", "declined"])).toBe("interrupted");
    expect(mcpAggregateStatus(["declined", "declined"])).toBe("declined");
    expect(mcpAggregateStatus(["completed", "declined"])).toBe("completed");
  });
});
