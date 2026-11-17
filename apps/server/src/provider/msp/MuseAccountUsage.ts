import type { ProviderInstanceId, UsageAccount } from "@t3tools/contracts";
import { Effect, Ref } from "effect";
import { accountUsageIdentity, type AccountUsageCapability } from "../../usage/accountUsage";
import { emptyAccountSection } from "../../usage/Layers/AccountUsageService";
import type { MuseSubscriptionUsage } from "./MuseUsageLimits";

interface MuseUsageState {
  readonly account: UsageAccount;
  readonly observedAt: number;
  readonly observedByRefresh: number;
}

/** Native Muse reports are account-wide; retain the newest one across sessions and status probes. */
export const makeMuseAccountUsage = (input: {
  instanceId: ProviderInstanceId;
  displayName: string;
  enabled: boolean;
  environment: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const initial: UsageAccount = {
      key: "muse:" + input.instanceId,
      provider: "muse",
      providerInstanceId: input.instanceId,
      displayName: input.displayName,
      enabled: input.enabled,
      refreshState: "idle",
      sections: [emptyAccountSection("provider-limits")],
    };
    const state = yield* Ref.make<MuseUsageState>({
      account: initial,
      observedAt: -1,
      observedByRefresh: -1,
    });
    const capability: AccountUsageCapability = {
      identity: accountUsageIdentity("muse", [
        input.instanceId,
        input.environment.HOME,
        input.environment.MUSE_HOME,
        input.environment.MUSE_CONFIG_DIR,
      ]),
      getSnapshot: Ref.get(state).pipe(Effect.map((value) => value.account)),
      refresh: () => Effect.void,
      refreshAccount: () =>
        Ref.modify(
          state,
          (value) =>
            [
              {
                snapshot: value.account,
                fresh: value.observedAt > value.observedByRefresh,
              },
              { ...value, observedByRefresh: value.observedAt },
            ] as const,
        ),
    };
    const publish = (usage: MuseSubscriptionUsage) =>
      Ref.update(state, (value): MuseUsageState => {
        if (!input.enabled || usage.observedAtMs < value.observedAt) return value;
        const fetchedAt = new Date(usage.observedAtMs).toISOString();
        const window = (id: string, label: string, report: MuseSubscriptionUsage["weekly"]) => ({
          id,
          label,
          usedPercent: Math.min(100, Math.max(0, report.usedPercent)),
          resetsAt: new Date(report.resetsAtMs).toISOString(),
        });
        return {
          ...value,
          observedAt: usage.observedAtMs,
          account: {
            ...initial,
            sections: [
              {
                kind: "provider-limits",
                outcome: "available",
                errorCode: null,
                lastAttemptAt: fetchedAt,
                snapshot: {
                  fetchedAt,
                  data: {
                    windows: [
                      window("session", "Session", usage.window),
                      window("weekly", "Weekly", usage.weekly),
                    ],
                    ...(usage.tier.trim() ? { plan: usage.tier.trim() } : {}),
                  },
                },
              },
            ],
          },
        };
      });
    return { capability, publish };
  });
