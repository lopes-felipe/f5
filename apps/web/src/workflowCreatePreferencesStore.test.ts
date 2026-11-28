import { beforeEach, describe, expect, it } from "vitest";

import {
  normalizePersistedWorkflowCreatePreferences,
  type SavedWorkflowSlot,
  useWorkflowCreatePreferencesStore,
} from "./workflowCreatePreferencesStore";

const codex: SavedWorkflowSlot = { provider: "codex", model: "gpt-5.4" };
const claude: SavedWorkflowSlot = { provider: "claudeAgent", model: "claude-opus-4-7" };

describe("normalizePersistedWorkflowCreatePreferences", () => {
  it("returns empty preferences for unreadable values", () => {
    expect(normalizePersistedWorkflowCreatePreferences(null)).toEqual({
      lastWorkflowType: null,
      setupsByType: {},
    });
    expect(normalizePersistedWorkflowCreatePreferences("codeReview")).toEqual({
      lastWorkflowType: null,
      setupsByType: {},
    });
  });

  it("drops unknown workflow types, providers and document types", () => {
    const normalized = normalizePersistedWorkflowCreatePreferences({
      lastWorkflowType: "unknown",
      setupsByType: {
        unknown: { actors: [codex, claude], merge: codex },
        document: {
          actors: [
            codex,
            { provider: "nope", model: "x" },
            { provider: "codex", model: " " },
            claude,
          ],
          merge: claude,
          documentType: "novel",
          readerReviewEnabled: false,
          reader: { provider: "nope", model: "x" },
        },
      },
    });
    expect(normalized.lastWorkflowType).toBeNull();
    expect(Object.keys(normalized.setupsByType)).toEqual(["document"]);
    expect(normalized.setupsByType.document).toEqual({
      actors: [codex, claude],
      merge: claude,
      readerReviewEnabled: false,
    });
  });

  it("discards a setup with fewer than two actors or no readable merge", () => {
    const normalized = normalizePersistedWorkflowCreatePreferences({
      lastWorkflowType: "planning",
      setupsByType: {
        planning: { actors: [codex, { provider: "nope", model: "x" }], merge: codex },
        codeReview: { actors: [codex, claude], merge: { provider: "codex" } },
        investigation: { actors: [codex, claude], merge: claude, selfReviewEnabled: true },
      },
    });
    expect(normalized.lastWorkflowType).toBe("planning");
    expect(normalized.setupsByType).toEqual({
      investigation: { actors: [codex, claude], merge: claude, selfReviewEnabled: true },
    });
  });

  it("trims actors to the workflow type's maximum", () => {
    const actors = Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? codex : claude));
    const normalized = normalizePersistedWorkflowCreatePreferences({
      setupsByType: {
        planning: { actors, merge: codex },
        codeReview: { actors, merge: codex, autoPost: true },
      },
    });
    expect(normalized.setupsByType.planning?.actors).toHaveLength(4);
    expect(normalized.setupsByType.codeReview?.actors).toHaveLength(6);
    expect(normalized.setupsByType.codeReview?.autoPost).toBe(true);
  });

  it("keeps only the slot's own provider options", () => {
    const normalized = normalizePersistedWorkflowCreatePreferences({
      setupsByType: {
        codeReview: {
          actors: [
            {
              ...codex,
              modelOptions: {
                codex: { reasoningEffort: "high" },
                claudeAgent: { effort: "max" },
              },
            },
            claude,
          ],
          merge: { ...claude, modelOptions: { codex: { reasoningEffort: "high" } } },
        },
      },
    });
    expect(normalized.setupsByType.codeReview).toEqual({
      actors: [{ ...codex, modelOptions: { codex: { reasoningEffort: "high" } } }, claude],
      merge: claude,
    });
  });

  it("keeps a reader that follows the merge model", () => {
    const normalized = normalizePersistedWorkflowCreatePreferences({
      setupsByType: {
        document: { actors: [codex, claude], merge: codex, documentType: "adr", reader: null },
      },
    });
    expect(normalized.setupsByType.document).toEqual({
      actors: [codex, claude],
      merge: codex,
      documentType: "adr",
      reader: null,
    });
  });
});

describe("useWorkflowCreatePreferencesStore", () => {
  beforeEach(() => {
    useWorkflowCreatePreferencesStore.setState({ lastWorkflowType: null, setupsByType: {} });
  });

  it("records the submitted type and keeps other types' setups", () => {
    const store = useWorkflowCreatePreferencesStore.getState();
    store.recordSubmitted("planning", {
      actors: [codex, claude],
      merge: codex,
      selfReviewEnabled: false,
      plansDirectory: "docs/plans",
    });
    store.recordSubmitted("codeReview", {
      actors: [codex, claude, codex],
      merge: claude,
      autoPost: true,
    });

    const state = useWorkflowCreatePreferencesStore.getState();
    expect(state.lastWorkflowType).toBe("codeReview");
    expect(state.setupsByType.planning).toEqual({
      actors: [codex, claude],
      merge: codex,
      selfReviewEnabled: false,
      plansDirectory: "docs/plans",
    });
    expect(state.setupsByType.codeReview?.actors).toHaveLength(3);
    expect(state.setupsByType.codeReview?.autoPost).toBe(true);
  });
});
