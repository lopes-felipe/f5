import { expect, it } from "vitest";
import { CODEX_CATALOG_TTL_MS, decideCodexCatalogProbe } from "./CodexDriver";

it("chooses probes, cached reads, background refresh and failure backoff", () => {
  const nowMs = Date.parse("2026-10-16T12:00:00Z");
  const cached = { version: "0.162.1", catalog: { fetchedAt: new Date(nowMs).toISOString() } };
  const input = { version: cached.version, nowMs, cached, failure: null };
  expect(decideCodexCatalogProbe({ ...input, cached: null })).toBe("probe");
  expect(decideCodexCatalogProbe(input)).toBe("use-cached");
  expect(decideCodexCatalogProbe({ ...input, nowMs: nowMs + CODEX_CATALOG_TTL_MS })).toBe(
    "use-cached-and-refresh",
  );
  expect(decideCodexCatalogProbe({ ...input, version: "0.163.0" })).toBe("probe");
  expect(
    decideCodexCatalogProbe({ ...input, failure: { version: cached.version, failedAt: nowMs } }),
  ).toBe("failed-backoff");
  expect(
    decideCodexCatalogProbe({
      ...input,
      nowMs: nowMs + 30 * 60 * 1000,
      failure: { version: cached.version, failedAt: nowMs },
    }),
  ).toBe("use-cached-and-refresh");
});
