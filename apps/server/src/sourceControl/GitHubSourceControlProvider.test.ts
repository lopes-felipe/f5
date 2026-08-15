import { describe, expect, it } from "vitest";
import { SOURCE_CONTROL_PULL_REQUEST_ACTIONS } from "@t3tools/contracts";
import { Effect, Exit } from "effect";

import { GitHubCliError } from "../git/Errors.ts";
import { makeFakeGitHubCli } from "../git/testDoubles.ts";
import {
  makeGitHubSourceControlProvider,
  mapGitHubCliError,
} from "./GitHubSourceControlProvider.ts";
import { makeSourceControlProviderRegistry } from "./SourceControlProvider.ts";

describe("GitHubSourceControlProvider", () => {
  it("forwards supported operations and exposes typed capabilities", async () => {
    const github = makeFakeGitHubCli();
    const provider = makeGitHubSourceControlProvider(github.service);

    await Effect.runPromise(
      provider.approvePullRequest({ cwd: "/repo", url: "https://github.com/octo/repo/pull/1" }),
    );
    expect(provider.capability("approve")).toMatchObject({ supported: true });

    const unsupported = await Effect.runPromiseExit(provider.requireCapability("react"));
    expect(Exit.isFailure(unsupported)).toBe(true);
    if (Exit.isFailure(unsupported)) {
      const error = String(unsupported.cause);
      expect(error).toContain("SourceControlProviderError");
      expect(error).toContain("react");
    }
  });

  it("declares every mutation as supported or explicitly unsupported", async () => {
    const provider = makeGitHubSourceControlProvider(makeFakeGitHubCli().service);

    expect(provider.capabilities.map(({ action }) => action)).toEqual([
      ...SOURCE_CONTROL_PULL_REQUEST_ACTIONS,
    ]);
    for (const capability of provider.capabilities) {
      const exit = await Effect.runPromiseExit(provider.requireCapability(capability.action));
      expect(Exit.isSuccess(exit)).toBe(capability.supported);
      if (!capability.supported) expect(capability.reason).toBeTruthy();
    }
  });

  it("fails closed when the registry has no adapter for an identity", async () => {
    const provider = makeGitHubSourceControlProvider(makeFakeGitHubCli().service);
    const registry = makeSourceControlProviderRegistry([provider]);

    const exit = await Effect.runPromiseExit(registry.getForIdentity({ kind: "gitlab" }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("provider 'gitlab'");
  });

  it("normalizes GitHub CLI failures at the adapter boundary", () => {
    const mapped = mapGitHubCliError(
      new GitHubCliError({
        operation: "gh.auth",
        detail: "gh was not found",
        kind: "binary_missing",
      }),
    );

    expect(mapped).toMatchObject({
      provider: "github",
      operation: "gh.auth",
      kind: "provider_missing",
    });
  });
});
