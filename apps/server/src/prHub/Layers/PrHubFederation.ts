import { Effect, Layer, PubSub, Scope, ServiceMap, Stream } from "effect";
import type { ForgeAccount, PrHubChanged, SourceControlPullRequestRef } from "@t3tools/contracts";
import {
  parseSourceControlPullRequestKey,
  parseSourceControlPullRequestUrl,
} from "@t3tools/shared/sourceControl";
import { ForgeAccounts } from "../../sourceControl/accountRouting.ts";
import {
  makeForgeSourceControlProvider,
  type ForgeKind,
  type ForgeProvider,
} from "../../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { makeGitHubCli } from "../../git/Layers/GitHubCli.ts";
import { makeGitHubRequestScheduler } from "../../git/githubRequestScheduler.ts";
import { GitHubCliError } from "../../git/Errors.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PrHubService, type PrHubServiceShape } from "../Services/PrHubService.ts";
import { PrHubReviewOperations } from "../Services/PrHubReviewOperations.ts";
import { PrHubReviewOperationsLive } from "./PrHubReviewOperations.ts";
import { makePrHubServiceForHost } from "./PrHubService.ts";
import { makeForgePrHubService } from "../forgeHub.ts";
import { makeGitHubForge } from "../githubForge.ts";
import { makeAccountRuntimeCache } from "../accountRuntimeCache.ts";
import { PrHubJobCoordinator } from "../Services/PrHubJobCoordinator.ts";
import { PrHubJobCoordinatorLive } from "./PrHubJobCoordinator.ts";

export interface PrHubAccountRuntime {
  readonly account: ForgeAccount;
  readonly hub: PrHubServiceShape;
  readonly provider: ForgeProvider;
  readonly github?: GitHubCliShape;
}
export interface PrHubRouteInput {
  readonly accountId?: string | undefined;
  readonly accountGeneration?: string | undefined;
  readonly key?: string | undefined;
  readonly url?: string | undefined;
}
export interface PrHubFederationShape {
  readonly hub: PrHubServiceShape;
  readonly resolve: (
    input: PrHubRouteInput,
  ) => Effect.Effect<PrHubAccountRuntime, SourceControlProviderError>;
  readonly parseUrl: (
    url: string,
  ) => Effect.Effect<SourceControlPullRequestRef | null, SourceControlProviderError>;
}
export class PrHubFederation extends ServiceMap.Service<PrHubFederation, PrHubFederationShape>()(
  "t3/prHub/Layers/PrHubFederation",
) {}
const failure = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.route",
    kind: "forbidden",
    detail,
  });
const sameRef = (left: SourceControlPullRequestRef, right: SourceControlPullRequestRef) =>
  left.provider === right.provider &&
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.repository === right.repository &&
  left.number === right.number;

/** Selection and generation are checked again for every operation, including explicit account IDs. */
export function makePrHubAccountRouter(options: {
  readonly listAccounts: () => Effect.Effect<readonly ForgeAccount[], SourceControlProviderError>;
  readonly routeAccount: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<ForgeAccount, SourceControlProviderError>;
  readonly build: (
    account: ForgeAccount,
  ) => Effect.Effect<PrHubAccountRuntime, SourceControlProviderError>;
  readonly legacy: Effect.Effect<PrHubAccountRuntime, SourceControlProviderError>;
  readonly parseUrl: (
    url: string,
  ) => Effect.Effect<SourceControlPullRequestRef | null, SourceControlProviderError>;
  readonly contextGeneration: (accountId: string, managerGeneration?: string) => string | undefined;
}) {
  return (input: PrHubRouteInput) =>
    Effect.gen(function* () {
      const values = yield* options.listAccounts();
      const keyRef = input.key ? parseSourceControlPullRequestKey(input.key) : null;
      const urlRef = input.url ? yield* options.parseUrl(input.url) : null;
      if (
        (input.key && !keyRef) ||
        (input.url && !urlRef) ||
        (keyRef && urlRef && !sameRef(keyRef, urlRef))
      )
        return yield* failure("Invalid or conflicting pull request target.");
      const ref = keyRef ?? urlRef;
      const hasManagedHost =
        ref &&
        values.some(
          (account) =>
            account.provider === ref.provider &&
            account.host.toLowerCase() === ref.host.toLowerCase(),
        );
      let selected: ForgeAccount | undefined;
      if (input.accountId) {
        selected = values.find((account) => account.id === input.accountId);
        if (!selected) return yield* failure("Account was not found.");
      } else if (hasManagedHost && ref) selected = yield* options.routeAccount(ref);
      else if (input.accountGeneration)
        selected = values.find(
          (account) =>
            account.generation === input.accountGeneration ||
            options.contextGeneration(account.id, account.generation) === input.accountGeneration,
        );
      if (selected && ref) {
        if (
          selected.provider !== ref.provider ||
          selected.host.toLowerCase() !== ref.host.toLowerCase()
        )
          return yield* failure(
            "Pull request provider or host does not match the selected account.",
          );
        if (hasManagedHost && (yield* options.routeAccount(ref)).id !== selected.id)
          return yield* failure("This repository is routed to a different account.");
      }
      const runtime = selected ? yield* options.build(selected) : yield* options.legacy;
      if (ref) {
        if (
          runtime.account.provider !== ref.provider ||
          runtime.account.host.toLowerCase() !== ref.host.toLowerCase()
        )
          return yield* failure(
            "Pull request provider or host does not match the selected account.",
          );
        if (
          !selected &&
          hasManagedHost &&
          (yield* options.routeAccount(ref)).id !== runtime.account.id
        )
          return yield* failure("This repository is routed to a different account.");
      }
      if (
        input.accountGeneration &&
        input.accountGeneration !== runtime.account.generation &&
        input.accountGeneration !==
          options.contextGeneration(runtime.account.id, runtime.account.generation)
      )
        return yield* failure("The account changed. Refresh PR Hub before continuing.");
      return runtime;
    });
}

export const PrHubFederationLive = Layer.effect(
  PrHubFederation,
  Effect.gen(function* () {
    const accounts = yield* ForgeAccounts,
      settings = yield* ServerSettingsService,
      config = yield* ServerConfig,
      scope = yield* Effect.scope;
    const services = yield* Effect.services<
      | Effect.Services<ReturnType<typeof makePrHubServiceForHost>>
      | Effect.Services<ReturnType<typeof makeGitHubCli>>
      | Effect.Services<ReturnType<typeof makeForgePrHubService>>
    >();
    const legacyCli = yield* GitHubCli,
      legacy = yield* makePrHubServiceForHost();
    const changes = yield* PubSub.sliding<PrHubChanged>(16);
    const forward = (hub: PrHubServiceShape, childScope: Scope.Scope) =>
      Stream.runForEach(hub.streamChanges, (value) =>
        PubSub.publish(changes, { ...value, resyncRequired: true }),
      ).pipe(Effect.forkIn(childScope));
    yield* forward(legacy, scope);
    const runtimeCache = yield* makeAccountRuntimeCache(scope, (identity, childScope) =>
      Effect.gen(function* () {
        const account = (yield* accounts.listAccounts()).find(
          (value) => value.id === identity.id && value.generation === identity.generation,
        );
        if (!account || account.provider === "unknown")
          return yield* failure("Account credentials changed or the provider is unsupported.");

        const assertCurrent = Effect.gen(function* () {
          const current = (yield* accounts.listAccounts()).find((value) => value.id === account.id);
          if (current?.generation !== account.generation)
            return yield* failure("Account credentials changed. Select the account again.");
        });
        const github =
          account.provider === "github"
            ? yield* makeGitHubCli({
                scheduler: makeGitHubRequestScheduler(),
                resolveToken: (host) =>
                  Effect.gen(function* () {
                    if (host.toLowerCase() !== account.host.toLowerCase())
                      return yield* failure("Account host mismatch.");
                    yield* assertCurrent;
                    return yield* accounts.getToken(account.id);
                  }).pipe(
                    Effect.mapError(
                      () =>
                        new GitHubCliError({
                          operation: "credentials",
                          kind: "unauthenticated",
                          detail: "Account credentials are unavailable.",
                        }),
                    ),
                  ),
              }).pipe(Effect.provideServices(services))
            : undefined;
        const provider = github
          ? makeGitHubForge(github, config.cwd)
          : makeForgeSourceControlProvider({
              kind: account.provider as ForgeKind,
              resolveAccount: (input) =>
                Effect.gen(function* () {
                  yield* assertCurrent;
                  if (
                    !input.ref ||
                    input.ref.provider !== account.provider ||
                    input.ref.host.toLowerCase() !== account.host.toLowerCase() ||
                    (yield* accounts.route(input.ref)).id !== account.id
                  )
                    return yield* failure("Provider account target mismatch.");
                  return {
                    ...account,
                    kind: account.provider as ForgeKind,
                    repository: input.ref.repository,
                    token: yield* accounts.getToken(account.id),
                  };
                }),
            });
        let hub: PrHubServiceShape,
          contextGeneration = account.generation;
        if (github) {
          const context = yield* github
            .getCredentialContext({ cwd: config.cwd, host: account.host })
            .pipe(
              Effect.mapError(() => failure("Could not verify the GitHub account credentials.")),
            );
          if (
            String(context.viewerId) !== account.viewerId ||
            context.login.toLowerCase() !== account.login.toLowerCase()
          )
            return yield* failure("The captured credential does not match this account identity.");
          contextGeneration = context.generation;
          // Review operations capture a CLI at construction, so build an account-specific service.
          const accountOperations = yield* Layer.build(
            Layer.merge(PrHubReviewOperationsLive, PrHubJobCoordinatorLive),
          ).pipe(
            Effect.provideService(GitHubCli, github),
            Effect.provideService(Scope.Scope, childScope),
            Effect.provideServices(services),
          );
          hub = yield* makePrHubServiceForHost(account.host).pipe(
            Effect.provideService(GitHubCli, github),
            Effect.provideService(
              PrHubReviewOperations,
              ServiceMap.get(accountOperations, PrHubReviewOperations),
            ),
            Effect.provideService(
              PrHubJobCoordinator,
              ServiceMap.get(accountOperations, PrHubJobCoordinator),
            ),
            Effect.provideService(Scope.Scope, childScope),
            Effect.provideServices(services),
          );
        } else
          hub = yield* makeForgePrHubService(account, provider).pipe(
            Effect.provideService(Scope.Scope, childScope),
            Effect.provideServices(services),
          );
        const runtime = { account, hub, provider, ...(github ? { github } : {}) };
        yield* forward(hub, childScope);
        return { runtime, contextGeneration };
      }),
    );
    const cached = runtimeCache.entries;
    const build = (account: ForgeAccount) =>
      runtimeCache.get(account).pipe(Effect.map((value) => value.runtime));
    const parseUrl = (url: string) =>
      accounts.listAccounts().pipe(
        Effect.map((values) => {
          const host = urlHost(url);
          const selected = values.find((account) => account.host.toLowerCase() === host);
          return parseSourceControlPullRequestUrl(url, selected?.provider, selected?.host);
        }),
      );
    const legacyRuntime = Effect.gen(function* () {
      const snapshot = yield* legacy.getSnapshot;
      if (!snapshot.account) return yield* failure("Connect an account before using PR Hub.");
      return {
        hub: legacy,
        github: legacyCli,
        provider: makeGitHubForge(legacyCli, config.cwd),
        account: {
          id: `legacy:${snapshot.host}:${snapshot.account.viewerId}`,
          provider: "github" as const,
          host: snapshot.host,
          login: snapshot.account.login,
          viewerId: String(snapshot.account.viewerId),
          generation: snapshot.account.generation,
        },
      };
    });
    const contextGeneration = (accountId: string, managerGeneration?: string) => {
      const value = cached.get(accountId);
      return value && (managerGeneration === undefined || value.generation === managerGeneration)
        ? value.value?.contextGeneration
        : undefined;
    };
    const resolve = makePrHubAccountRouter({
      listAccounts: accounts.listAccounts,
      routeAccount: accounts.route,
      build,
      legacy: legacyRuntime,
      parseUrl,
      contextGeneration,
    });
    const methods = Object.fromEntries(
      Object.entries(legacy)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => [
          name,
          (input: PrHubRouteInput = {}) => {
            const method = (runtime: PrHubServiceShape, argument: PrHubRouteInput) =>
              (
                runtime[name as keyof PrHubServiceShape] as (
                  input: PrHubRouteInput,
                ) => Effect.Effect<unknown, SourceControlProviderError>
              )(argument);
            if (!input.accountId && !input.accountGeneration && !input.key && !input.url)
              return method(legacy, input);
            return resolve(input).pipe(
              Effect.flatMap((runtime) =>
                method(
                  runtime.hub,
                  input.accountGeneration
                    ? {
                        ...input,
                        accountGeneration:
                          contextGeneration(runtime.account.id) ?? runtime.account.generation,
                      }
                    : input,
                ),
              ),
            );
          },
        ]),
    );
    let monitoringStarted = false;
    const monitoring = Effect.suspend(() => {
      if (monitoringStarted) return Effect.void;
      monitoringStarted = true;
      return Effect.gen(function* () {
        yield* legacy.startMonitoring;
        yield* Effect.forever(
          Effect.gen(function* () {
            const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
            const interval = current?.prHub.pollIntervalSeconds ?? 180;
            if (interval !== 0) {
              const values = yield* accounts.listAccounts().pipe(Effect.orElseSucceed(() => []));
              const priority = [...cached.keys()].flatMap((id) => {
                const account = values.find((value) => value.id === id);
                return account ? [account] : [];
              });
              const selected = [
                ...priority,
                ...values.filter((account) => !cached.has(account.id)),
              ].slice(0, 32);
              yield* Effect.forEach(
                selected,
                (account) =>
                  build(account).pipe(
                    Effect.flatMap((runtime) => runtime.hub.refreshNow({ mode: "if_stale" })),
                    Effect.ignoreCause(),
                  ),
                { concurrency: 2 },
              );
            }
            yield* Effect.sleep(Math.max(30, interval) * 1000);
          }),
        ).pipe(Effect.forkIn(scope));
      }).pipe(Effect.asVoid);
    });
    const hub = {
      ...legacy,
      ...methods,
      getSnapshot: legacy.getSnapshot,
      startMonitoring: monitoring,
      streamChanges: Stream.fromPubSub(changes),
    } as PrHubServiceShape;
    return { hub, resolve, parseUrl } satisfies PrHubFederationShape;
  }),
);
const urlHost = (value: string): string | undefined => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
export const PrHubFederatedServiceLive = Layer.effect(
  PrHubService,
  Effect.gen(function* () {
    return (yield* PrHubFederation).hub;
  }),
);
