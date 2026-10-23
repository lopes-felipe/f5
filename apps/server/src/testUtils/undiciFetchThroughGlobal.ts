import type * as OutboundHttp from "../outboundHttp.ts";

/**
 * A `vi.mock` factory for `outboundHttp.ts`. GitHub requests use undici's own
 * fetch with a proxy dispatcher; this routes that fetch through the global
 * fetch a test stubs with `vi.stubGlobal("fetch", ...)`.
 */
export async function undiciFetchThroughGlobal(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof OutboundHttp> {
  const original = await importOriginal<typeof OutboundHttp>();
  return {
    ...original,
    requireUndici: () =>
      ({
        ...original.requireUndici(),
        fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          globalThis.fetch(input, init),
      }) as unknown as ReturnType<typeof original.requireUndici>,
  };
}
