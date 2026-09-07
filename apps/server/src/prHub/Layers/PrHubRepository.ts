import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PrHubRepository } from "../Services/PrHubRepository.ts";
import { createPrHubRepository } from "../repository.ts";
export const PrHubRepositoryLive = Layer.effect(
  PrHubRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return { create: (context) => createPrHubRepository({ ...context, sql }) };
  }),
);
