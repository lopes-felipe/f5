import { describe, expect, it } from "vitest";

import { cliAccountStrategy, parseCursorAccountStatus } from "./providerAccountStrategy.ts";

describe("Cursor CLI account strategy", () => {
  it("reads `agent status --format json`", () => {
    expect(
      parseCursorAccountStatus({
        code: 0,
        stdout: JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          userInfo: { email: "dev@example.com" },
        }),
        stderr: "",
      }),
    ).toEqual({ status: "authenticated", detail: "Signed in to Cursor as dev@example.com." });
    expect(
      parseCursorAccountStatus({
        code: 0,
        stdout: JSON.stringify({ status: "unauthenticated", isAuthenticated: false }),
        stderr: "",
      }).status,
    ).toBe("unauthenticated");
    expect(parseCursorAccountStatus({ code: 1, stdout: "", stderr: "boom" }).status).toBe(
      "unauthenticated",
    );
  });

  it("signs in through the CLI and shares one credential store across instances", () => {
    const strategy = cliAccountStrategy("cursor");
    expect(strategy.loginArgs("browser")).toEqual(["login"]);
    expect(strategy.logoutArgs).toEqual(["logout"]);
    expect(strategy.statusArgs).toEqual(["status", "--format", "json"]);
    expect(strategy.sharesCredentialStore).toBe(true);
    expect(strategy.oauthCallbackPort).toBeUndefined();
    expect([...strategy.credentialVariables]).toContain("CURSOR_API_KEY");
    expect(cliAccountStrategy("codex").loginArgs("device-code")).toEqual([
      "login",
      "--device-auth",
    ]);
  });
});
