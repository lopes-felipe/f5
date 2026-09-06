import type { discoverNotificationSubjects } from "../notificationDiscovery.ts";
import { ServiceMap, type Effect } from "effect";
import type * as Discovery from "../discovery.ts";

type Provided<F extends (...args: never[]) => Effect.Effect<unknown, unknown, unknown>> = (
  ...args: Parameters<F>
) => Effect.Effect<Effect.Success<ReturnType<F>>, Effect.Error<ReturnType<F>>>;

export interface PrHubDiscoveryShape {
  readonly recordPrHubMembership: Provided<typeof Discovery.recordPrHubMembership>;
  readonly discoverNotificationSubjects: Provided<typeof discoverNotificationSubjects>;
  readonly enqueuePrHubTracked: Provided<typeof Discovery.enqueuePrHubTracked>;
  readonly ingestPrHubSearch: Provided<typeof Discovery.ingestPrHubSearch>;
  readonly beginPrHubSearch: Provided<typeof Discovery.beginPrHubSearch>;
  readonly resumePrHubSearch: Provided<typeof Discovery.resumePrHubSearch>;
  readonly selectPrHubHydration: Provided<typeof Discovery.selectPrHubHydration>;
  readonly finishPrHubHydration: Provided<typeof Discovery.finishPrHubHydration>;
  readonly syncPrHubRepositories: Provided<typeof Discovery.syncPrHubRepositories>;
}
export class PrHubDiscovery extends ServiceMap.Service<PrHubDiscovery, PrHubDiscoveryShape>()(
  "t3/prHub/Services/PrHubDiscovery",
) {}
