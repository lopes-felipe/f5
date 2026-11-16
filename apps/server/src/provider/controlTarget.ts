import { ServiceMap } from "effect";

/** Origin captured before control admission, checked inside the provider thread lock. */
export interface ProviderControlOrigin {
  readonly threadId: string;
  readonly provider: string | null;
  readonly instanceId: string | null;
  readonly generation: number | null;
  readonly activeTurnId: string | null;
}
export const ProviderControlTarget = ServiceMap.Reference<ProviderControlOrigin | undefined>(
  "f5/provider/ControlTarget",
  { defaultValue: () => undefined },
);
