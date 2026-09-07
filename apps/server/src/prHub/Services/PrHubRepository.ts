import { ServiceMap } from "effect";
import type { createPrHubRepository, PrHubRepositoryContext } from "../repository.ts";
export class PrHubRepository extends ServiceMap.Service<
  PrHubRepository,
  { readonly create: (context: PrHubRepositoryContext) => ReturnType<typeof createPrHubRepository> }
>()("t3/prHub/Services/PrHubRepository") {}
