import { describe, expect, it } from "vitest";
import { normalizeGithubHost } from "./github";

describe("normalizeGithubHost", () => {
  it("normalizes pasted URLs and casing", () => {
    expect(normalizeGithubHost(" https://GitHub.com/ ")).toBe("github.com");
    expect(normalizeGithubHost("ghe.example.com")).toBe("ghe.example.com");
    expect(normalizeGithubHost("http://ghe.example.com//")).toBe("ghe.example.com");
  });

  it("rejects values the contract would reject", () => {
    expect(normalizeGithubHost("")).toBeNull();
    expect(normalizeGithubHost("   ")).toBeNull();
    expect(normalizeGithubHost("github.com:443")).toBeNull();
    expect(normalizeGithubHost("github.com/org")).toBeNull();
    expect(normalizeGithubHost("a..b")).toBeNull();
    expect(normalizeGithubHost("-github.com")).toBeNull();
  });
});
