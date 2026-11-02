// @effect-diagnostics globalTimers:off
const unavailableCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"]);

/** A committed handoff can precede HTTP listening. Only transport unavailability is retryable. */
export async function waitForCliBootstrap(
  url: string,
  stopped: () => boolean,
  diagnostics: () => string | Promise<string>,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped()) throw new Error("CLI server exited: " + (await diagnostics()));
    let response: Response | undefined;
    try {
      response = await fetch(url + "/api/bootstrap", { signal: AbortSignal.timeout(1000) });
    } catch (error) {
      const failure = error as { name?: string; cause?: { code?: string } };
      if (failure.name !== "TimeoutError" && !unavailableCodes.has(failure.cause?.code ?? ""))
        throw error;
    }
    if (response?.ok) {
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("protocolVersion" in body))
        throw new Error("CLI bootstrap protocol is missing");
      return body as Record<string, unknown>;
    }
    if (response && response.status !== 503)
      throw new Error("CLI bootstrap returned HTTP " + response.status);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("CLI server did not become ready: " + (await diagnostics()));
}
