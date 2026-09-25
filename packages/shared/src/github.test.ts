import { describe, expect, it } from "vitest";
import { normalizeGithubHost, parseGhDeviceLogin } from "./github";

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

describe("parseGhDeviceLogin", () => {
  // Recorded from gh 2.101.0 with non-interactive stdin.
  const nonInteractive =
    "\n! One-time code (F8C3-8E85) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  const interactive =
    "\n! First copy your one-time code: AB12-CD34\nPress Enter to open https://github.com/login/device in your browser... ";

  it("reads the clipboard-style prompt", () => {
    expect(parseGhDeviceLogin(nonInteractive, "github.com")).toEqual({
      userCode: "F8C3-8E85",
      verificationUri: "https://github.com/login/device",
      awaitsEnter: false,
    });
  });

  it("reads the press-enter prompt", () => {
    expect(parseGhDeviceLogin(interactive, "github.com")).toEqual({
      userCode: "AB12-CD34",
      verificationUri: "https://github.com/login/device",
      awaitsEnter: true,
    });
  });

  it("waits until both code and a complete link arrive", () => {
    expect(parseGhDeviceLogin("! First copy your one-time code: AB12-CD34\n", "github.com")).toBe(
      null,
    );
    expect(
      parseGhDeviceLogin(nonInteractive.slice(0, nonInteractive.length - 1), "github.com"),
    ).toBeNull();
  });

  it("ignores links for another host", () => {
    expect(parseGhDeviceLogin(nonInteractive, "ghe.example.com")).toBeNull();
  });
});
