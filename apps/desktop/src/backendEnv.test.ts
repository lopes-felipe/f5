import { describe, expect, it } from "vitest";

import {
  buildDesktopBackendEnv,
  resolveDesktopStateDir,
  resolveDesktopStateDirConfig,
} from "./backendEnv";

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
        stateDirSource: "explicit-state",
        authToken: "token-123",
      },
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      T3CODE_MODE: "desktop",
      T3CODE_NO_BROWSER: "1",
      T3CODE_PORT: "3773",
      F5_STATE_DIR: "/tmp/t3-state",
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
        stateDirSource: "default",
        authToken: "token-123",
      },
    );

    expect(env.T3CODE_OBSERVABILITY_ENABLED).toBeUndefined();
  });

  it("does not synthesize state-dir env when desktop used the default state dir", () => {
    const env = buildDesktopBackendEnv(
      {
        PATH: "/usr/bin",
      },
      {
        backendPort: 3773,
        stateDir: "/Users/test-user/.f5/userdata",
        stateDirSource: "default",
        authToken: "token-123",
      },
    );

    expect(env.F5_STATE_DIR).toBeUndefined();
    expect(env.T3CODE_STATE_DIR).toBeUndefined();
  });

  it("does not synthesize state-dir env when desktop resolved a home override", () => {
    const env = buildDesktopBackendEnv(
      {
        PATH: "/usr/bin",
        F5_HOME: "/tmp/f5-home",
      },
      {
        backendPort: 3773,
        stateDir: "/tmp/f5-home/userdata",
        stateDirSource: "home",
        authToken: "token-123",
      },
    );

    expect(env.F5_HOME).toBe("/tmp/f5-home");
    expect(env.F5_STATE_DIR).toBeUndefined();
    expect(env.T3CODE_STATE_DIR).toBeUndefined();
  });

  it("defaults desktop state to the F5 userdata directory", () => {
    expect(resolveDesktopStateDir({}, "/Users/test-user")).toBe("/Users/test-user/.f5/userdata");
  });

  it("marks the default desktop state as not explicit", () => {
    expect(resolveDesktopStateDirConfig({}, "/Users/test-user")).toEqual({
      stateDir: "/Users/test-user/.f5/userdata",
      source: "default",
    });
  });

  it("prefers F5_STATE_DIR over legacy T3CODE_STATE_DIR", () => {
    expect(
      resolveDesktopStateDirConfig(
        {
          F5_STATE_DIR: "/tmp/f5-state",
          T3CODE_STATE_DIR: "/tmp/t3-state",
        },
        "/Users/test-user",
      ),
    ).toEqual({ stateDir: "/tmp/f5-state", source: "explicit-state" });
  });

  it("resolves F5_HOME to its userdata state directory", () => {
    expect(resolveDesktopStateDirConfig({ F5_HOME: "/tmp/f5-home" }, "/Users/test-user")).toEqual({
      stateDir: "/tmp/f5-home/userdata",
      source: "home",
    });
  });

  it("prefers legacy explicit state over F5_HOME", () => {
    expect(
      resolveDesktopStateDir(
        {
          T3CODE_STATE_DIR: "/tmp/t3-state",
          F5_HOME: "/tmp/f5-home",
        },
        "/Users/test-user",
      ),
    ).toBe("/tmp/t3-state");
  });

  it("resolves legacy T3CODE_HOME when no F5 state or home is configured", () => {
    expect(resolveDesktopStateDir({ T3CODE_HOME: "~/t3-home" }, "/Users/test-user")).toBe(
      "/Users/test-user/t3-home/userdata",
    );
  });
});
