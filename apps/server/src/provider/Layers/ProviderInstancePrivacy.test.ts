import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Logger, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderDriverError } from "../Errors.ts";
import type { AnyProviderDriver } from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

describe("provider initialization privacy", () => {
  it.each(["decode", "create"] as const)(
    "keeps credentials out of %s diagnostics and client snapshots",
    async (mode) => {
      const secret = "private-provider-credential";
      const messages: unknown[] = [];
      const driver = {
        driverKind: ProviderDriverKind.make("privacy-fixture"),
        metadata: { displayName: "Fixture" },
        configSchema:
          mode === "decode"
            ? Schema.Struct({ serverPassword: Schema.Literal("required-value") })
            : Schema.Unknown,
        defaultConfig: () => ({}),
        create: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: "privacy-fixture",
              detail: `Connection failed with ${secret}`,
              cause: new Error(secret),
            }),
          ),
      } satisfies AnyProviderDriver<never>;
      const snapshots = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { registry } = yield* makeProviderInstanceRegistry({
              drivers: [driver],
              configMap: {
                [ProviderInstanceId.make("privacy_fixture")]: {
                  driver: driver.driverKind,
                  config: { serverPassword: secret },
                },
              },
            });
            return yield* registry.listUnavailable;
          }),
        ).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                messages.push(options.message);
              }),
            ]),
          ),
        ),
      );
      expect(snapshots).toHaveLength(1);
      expect(JSON.stringify(snapshots)).not.toContain(secret);
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(JSON.stringify(messages)).toContain("privacy_fixture");
      expect(snapshots[0]?.unavailableReason).toMatch(/config|initializ/i);
    },
  );
});
