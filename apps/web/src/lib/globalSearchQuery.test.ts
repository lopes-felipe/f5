import { describe, expect, it } from "vitest";
import { ProjectId } from "@t3tools/contracts";

import { buildGlobalSearchQueryInput, parseGlobalSearchQuery } from "./globalSearchQuery";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

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

  it("builds one shared query input for palette and sidebar searches", () => {
    expect(
      buildGlobalSearchQueryInput({
        parsed: parseGlobalSearchQuery('retry project:"F5 App" archived:true'),
        projects: [{ id: PROJECT_ID, name: "F5 App" }],
        limit: 12,
      }),
    ).toEqual({
      query: "retry",
      projectId: PROJECT_ID,
      includeArchived: true,
      limit: 12,
    });
  });

  it("does not query FTS for short text or unknown project filters", () => {
    const projects = [{ id: PROJECT_ID, name: "F5 App" }];
    expect(
      buildGlobalSearchQueryInput({ parsed: parseGlobalSearchQuery("x"), projects }),
    ).toBeNull();
    expect(
      buildGlobalSearchQueryInput({
        parsed: parseGlobalSearchQuery("retry project:missing"),
        projects,
      }),
    ).toBeNull();
  });
});
