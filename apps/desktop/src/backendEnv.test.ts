import { describe, expect, it } from "vitest";

import { buildDesktopBackendEnv } from "./backendEnv";

describe("buildDesktopBackendEnv", () => {
  it("forwards observability enablement when explicitly set", () => {
    const env = buildDesktopBackendEnv(
      {
        PATH: "/usr/bin",
        T3CODE_OBSERVABILITY_ENABLED: "true",
      },
      {
        backendPort: 3773,
        stateDir: "/tmp/t3-state",
        authToken: "token-123",
      },
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      T3CODE_MODE: "desktop",
      T3CODE_NO_BROWSER: "1",
      T3CODE_PORT: "3773",
      T3CODE_STATE_DIR: "/tmp/t3-state",
      T3CODE_AUTH_TOKEN: "token-123",
      T3CODE_OBSERVABILITY_ENABLED: "true",
    });
  });

  it("does not add observability enablement when it is absent", () => {
    const env = buildDesktopBackendEnv(
      {
        PATH: "/usr/bin",
      },
      {
        backendPort: 3773,
        stateDir: "/tmp/t3-state",
        authToken: "token-123",
      },
    );

    expect(env.T3CODE_OBSERVABILITY_ENABLED).toBeUndefined();
  });
});
