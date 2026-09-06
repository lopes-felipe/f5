import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";
import type {
  PrHubAdvisorySnapshot,
  PrHubAdvisoriesChanged,
  PrHubAnalyzeAdvisoriesInput,
  PrHubGetAdvisoriesInput,
} from "@t3tools/contracts";

export interface PrHubAdvisoryServiceShape {
  readonly getAdvisories: (input?: PrHubGetAdvisoriesInput) => Effect.Effect<PrHubAdvisorySnapshot>;
  readonly analyzeAdvisories: (
    input?: PrHubAnalyzeAdvisoriesInput,
  ) => Effect.Effect<PrHubAdvisorySnapshot>;
  readonly streamAdvisories: Stream.Stream<PrHubAdvisoriesChanged>;
}

export class PrHubAdvisoryService extends ServiceMap.Service<
  PrHubAdvisoryService,
  PrHubAdvisoryServiceShape
>()("t3/prHub/Services/PrHubAdvisoryService") {}
