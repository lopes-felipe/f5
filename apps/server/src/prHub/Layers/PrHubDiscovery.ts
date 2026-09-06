import { discoverNotificationSubjects } from "../notificationDiscovery.ts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PrHubDiscovery } from "../Services/PrHubDiscovery.ts";
import {
  ingestPrHubSearch,
  recordPrHubMembership,
  enqueuePrHubTracked,
  beginPrHubSearch,
  resumePrHubSearch,
  selectPrHubHydration,
  finishPrHubHydration,
  syncPrHubRepositories,
} from "../discovery.ts";

export const PrHubDiscoveryLive = Layer.effect(
  PrHubDiscovery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      recordPrHubMembership: (...args: Parameters<typeof recordPrHubMembership>) =>
        recordPrHubMembership(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      discoverNotificationSubjects: (...args: Parameters<typeof discoverNotificationSubjects>) =>
        discoverNotificationSubjects(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      enqueuePrHubTracked: (...args: Parameters<typeof enqueuePrHubTracked>) =>
        enqueuePrHubTracked(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ingestPrHubSearch: (...args: Parameters<typeof ingestPrHubSearch>) =>
        ingestPrHubSearch(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      beginPrHubSearch: (...args: Parameters<typeof beginPrHubSearch>) =>
        beginPrHubSearch(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      resumePrHubSearch: (...args: Parameters<typeof resumePrHubSearch>) =>
        resumePrHubSearch(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      selectPrHubHydration: (...args: Parameters<typeof selectPrHubHydration>) =>
        selectPrHubHydration(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      finishPrHubHydration: (...args: Parameters<typeof finishPrHubHydration>) =>
        finishPrHubHydration(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      syncPrHubRepositories: (...args: Parameters<typeof syncPrHubRepositories>) =>
        syncPrHubRepositories(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    };
  }),
);
