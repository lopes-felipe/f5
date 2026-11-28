import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { AccountUsageReadError } from "../usage/accountUsageErrors.ts";
import type { prepareAntigravityProfile } from "./acp/AntigravityAcpSupport.ts";
import { ANTIGRAVITY_PERSONAL_AUTH } from "./antigravityAuthSupport.ts";
import {
  makeAntigravityUsageRun,
  type AntigravityUsageRunDependencies,
} from "./antigravityUsageRun.ts";

const ok: ProcessRunResult = { stdout: "{}", stderr: "", code: 0, signal: null, timedOut: false };

const setup = (overrides: Partial<AntigravityUsageRunDependencies> = {}) => {
  const events: Array<string> = [];
  let revision = 4;
  const dependencies: Partial<AntigravityUsageRunDependencies> = {
    acquireAdmission: () => {
      events.push("admit");
      return () => events.push("release");
    },
    isAuthCurrent: () => true,
    readiness: async () => ({
      ready: true,
      authType: "oauth-personal",
      authLabel: "Google account",
      action: undefined,
      message: undefined,
    }),
    revision: async () => revision,
    accountKey: async () => "v2:account",
    prepare: async () =>
      ({
        executable: { executablePath: "/runtime/antigravity", version: "1.5.15" },
        home: "/profile",
        browser: "browser",
      }) as unknown as Awaited<ReturnType<typeof prepareAntigravityProfile>>,
    runCommand: async (input) => {
      events.push(`spawn ${input.executablePath} ${input.profileDirectory}`);
      return ok;
    },
    ...overrides,
  };
  const run = makeAntigravityUsageRun({
    stateDir: "/state",
    instanceId: "antigravity",
    profileDirectory: "/profile",
    auth: ANTIGRAVITY_PERSONAL_AUTH,
    keyUnavailable: false,
    environment: { PATH: "/usr/bin" },
    dependencies,
  });
  return {
    events,
    run,
    bumpRevision: () => {
      revision += 1;
    },
  };
};

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof AccountUsageReadError ? error.code : String(error)),
  );

describe("makeAntigravityUsageRun", () => {
  it("holds admission until the CLI exits and gates the binary it runs", async () => {
    const { events, run } = setup();
    const result = await run(new AbortController().signal, async ({ version, account, spawn }) => {
      events.push(`gate ${version} ${account}`);
      return spawn();
    });
    expect(result).toBe(ok);
    expect(events).toEqual([
      "admit",
      "gate 1.5.15 v2:account",
      "spawn /runtime/antigravity /profile",
      "release",
    ]);
  });

  it("checks sign-in settings and readiness under admission, before preparing anything", async () => {
    let prepared = 0;
    const prepare: AntigravityUsageRunDependencies["prepare"] = async () => {
      prepared += 1;
      throw new Error("unreachable");
    };
    const stale = setup({ isAuthCurrent: () => false, prepare });
    expect(await code(stale.run(new AbortController().signal, async () => "body"))).toBe(
      "temporary-failure",
    );
    expect(stale.events).toEqual(["admit", "release"]);
    const signedOut = setup({
      prepare,
      readiness: async () => ({
        ready: false,
        authType: "oauth-personal",
        authLabel: "Google account",
        action: "Sign in",
        message: "Sign in to Antigravity in Settings.",
      }),
    });
    expect(await code(signedOut.run(new AbortController().signal, async () => "body"))).toBe(
      "authentication-required",
    );
    expect(prepared).toBe(0);
  });

  it("refuses while an account change holds the instance", async () => {
    const { run } = setup({
      acquireAdmission: () => {
        throw new Error("Account change in progress.");
      },
    });
    let ran = false;
    expect(
      await code(
        run(new AbortController().signal, async () => {
          ran = true;
        }),
      ),
    ).toBe("temporary-failure");
    expect(ran).toBe(false);
  });

  it("discards a run that straddled an account revision change", async () => {
    const { events, run, bumpRevision } = setup();
    expect(
      await code(
        run(new AbortController().signal, async ({ spawn }) => {
          const result = await spawn();
          bumpRevision();
          return result;
        }),
      ),
    ).toBe("temporary-failure");
    expect(events.at(-1)).toBe("release");
  });

  it("reports a missing install and a failed spawn as process-unavailable", async () => {
    const missing = setup({
      prepare: async () => {
        throw new Error("not installed");
      },
    });
    expect(await code(missing.run(new AbortController().signal, async () => "body"))).toBe(
      "process-unavailable",
    );
    const broken = setup({
      runCommand: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await code(broken.run(new AbortController().signal, async ({ spawn }) => spawn()))).toBe(
      "process-unavailable",
    );
    expect(broken.events.at(-1)).toBe("release");
  });
});
