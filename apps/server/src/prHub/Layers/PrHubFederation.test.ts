import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ForgeAccount } from "@t3tools/contracts";
import { parseSourceControlPullRequestUrl } from "@t3tools/shared/sourceControl";
import { makePrHubAccountRouter, type PrHubAccountRuntime } from "./PrHubFederation.ts";
import type { ForgeProvider } from "../../sourceControl/ForgeSourceControlProvider.ts";
import type { PrHubServiceShape } from "../Services/PrHubService.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";

const alice: ForgeAccount = {
  id: "alice",
  provider: "github",
  host: "ghe.example.com",
  login: "alice",
  viewerId: "1",
  generation: "manager-alice",
};
const bob: ForgeAccount = {
  ...alice,
  id: "bob",
  login: "bob",
  viewerId: "2",
  generation: "manager-bob",
};
const legacy = { ...alice, id: "legacy", host: "github.com", generation: "legacy-context" };
const runtime = (account: ForgeAccount): PrHubAccountRuntime => ({
  account,
  hub: {} as PrHubServiceShape,
  provider: {} as ForgeProvider,
});
const deny = () =>
  new SourceControlProviderError({
    provider: "github",
    operation: "test.route",
    kind: "forbidden",
    detail: "Explicit routing required.",
  });
function setup() {
  let values: readonly ForgeAccount[] = [alice, bob];
  let builds = 0;
  const router = makePrHubAccountRouter({
    removeAccount: () => Effect.void,
    listAccounts: () => Effect.succeed(values),
    routeAccount: (ref) =>
      ref.repository === "org/alice"
        ? Effect.succeed(values.find((account) => account.id === "alice")!)
        : ref.repository === "org/bob"
          ? Effect.succeed(bob)
          : Effect.fail(deny()),
    build: (account) =>
      Effect.sync(() => {
        builds++;
        return runtime(account);
      }),
    legacy: Effect.succeed(runtime(legacy)),
    parseUrl: (url) =>
      Effect.succeed(
        parseSourceControlPullRequestUrl(
          url,
          url.includes("ghe.example.com") ? "github" : undefined,
        ),
      ),
    contextGeneration: (id) =>
      id === "alice" ? "verified-alice" : id === "bob" ? "verified-bob" : undefined,
  });
  return {
    router,
    setAccounts: (next: readonly ForgeAccount[]) => {
      values = next;
    },
    builds: () => builds,
  };
}
const refKey = (repository: string, host = "ghe.example.com") => `github:${host}/${repository}#7`;
describe("PR Hub account router", () => {
  it("checks repository routing even when the caller supplies an explicit account", async () => {
    const { router } = setup();
    expect(
      (await Effect.runPromise(router({ accountId: "alice", key: refKey("org/alice") }))).account
        .id,
    ).toBe("alice");
    expect(
      (
        await Effect.runPromise(
          router({ accountId: "alice", key: refKey("org/bob") }).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
    expect(
      (
        await Effect.runPromise(
          router({ accountId: "alice", key: refKey("org/unknown") }).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
  });
  it("rejects explicit-account requests for a different provider or host", async () => {
    const { router } = setup();
    for (const key of [
      refKey("org/alice", "other.example.com"),
      "gitlab:ghe.example.com/org/alice#7",
    ]) {
      expect(
        (await Effect.runPromise(router({ accountId: "alice", key }).pipe(Effect.result)))._tag,
      ).toBe("Failure");
    }
  });
  it("accepts manager and verified GitHub generations only for their account", async () => {
    const { router } = setup();
    for (const generation of ["manager-alice", "verified-alice"]) {
      expect(
        (
          await Effect.runPromise(
            router({ key: refKey("org/alice"), accountGeneration: generation }),
          )
        ).account.id,
      ).toBe("alice");
    }
    expect(
      (
        await Effect.runPromise(
          router({ key: refKey("org/alice"), accountGeneration: "verified-bob" }).pipe(
            Effect.result,
          ),
        )
      )._tag,
    ).toBe("Failure");
    expect(
      (
        await Effect.runPromise(
          router({ accountId: "alice", accountGeneration: "old-generation" }).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
  });
  it("selects the legacy profile when no managed account was requested", async () => {
    const { router, builds } = setup();
    expect((await Effect.runPromise(router({}))).account.id).toBe("legacy");
    expect(
      (await Effect.runPromise(router({ key: refKey("org/repo", "github.com") }))).account.id,
    ).toBe("legacy");
    expect(builds()).toBe(0);
  });
  it("does not fall back to the profile for unknown account IDs or malformed targets", async () => {
    const { router } = setup();
    for (const input of [
      { accountId: "absent" },
      { key: "invalid" },
      { url: "https://evil.test/secret" },
      { key: refKey("org/alice"), url: "https://ghe.example.com/org/alice/pull/8" },
    ]) {
      expect((await Effect.runPromise(router(input).pipe(Effect.result)))._tag).toBe("Failure");
    }
  });
  it("routes qualified links to their own account and rejects mismatched key/url tuples", async () => {
    const { router } = setup();
    expect(
      (await Effect.runPromise(router({ url: "https://ghe.example.com/org/bob/pull/7" }))).account
        .id,
    ).toBe("bob");
    expect(
      (
        await Effect.runPromise(
          router({ accountId: "alice", url: "https://ghe.example.com/org/bob/pull/7" }).pipe(
            Effect.result,
          ),
        )
      )._tag,
    ).toBe("Failure");
  });
});
