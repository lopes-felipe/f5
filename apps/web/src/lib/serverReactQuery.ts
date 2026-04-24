import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { ProviderStartOptions } from "@t3tools/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function validateHarnessesMutationOptions() {
  return mutationOptions({
    mutationKey: ["server", "validateHarnesses"] as const,
    mutationFn: async (input?: { providerOptions?: ProviderStartOptions }) => {
      const api = ensureNativeApi();
      const { results } = await api.server.validateHarnesses(input);
      return results;
    },
    retry: false,
  });
}
