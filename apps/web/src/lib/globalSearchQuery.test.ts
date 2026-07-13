import { describe, expect, it } from "vitest";

import { parseGlobalSearchQuery } from "./globalSearchQuery";

describe("parseGlobalSearchQuery", () => {
  it("extracts quoted filters without including them in full-text search", () => {
    expect(
      parseGlobalSearchQuery(
        'reconnect recovery project:"F5 App" provider:codex-work model:gpt-5 status:ready after:2026-01-02 before:2026-02-03 archived:true',
      ),
    ).toEqual({
      text: "reconnect recovery",
      project: "F5 App",
      provider: "codex-work",
      model: "gpt-5",
      status: "ready",
      dateFrom: "2026-01-02T00:00:00.000Z",
      dateTo: "2026-02-03T23:59:59.999Z",
      includeArchived: true,
    });
  });

  it("ignores invalid dates", () => {
    expect(parseGlobalSearchQuery("snapshot after:not-a-date").dateFrom).toBeNull();
  });
});
