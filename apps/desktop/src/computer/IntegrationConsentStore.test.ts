import { describe, expect, it } from "vitest";
import {
  IntegrationConsentStore,
  disclosuresDigest,
  type IntegrationConsentIo,
} from "./IntegrationConsentStore";

function memoryIo(initial?: string) {
  const state = { contents: initial, writes: 0, failWrites: false };
  const io: IntegrationConsentIo = {
    read: () => state.contents,
    write: (contents) => {
      if (state.failWrites) throw new Error("disk full");
      state.writes += 1;
      state.contents = contents;
    },
  };
  return { io, state };
}

describe("IntegrationConsentStore", () => {
  it("keeps a grant per profile and integration across restarts", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io);
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    store.allow("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(true);
    expect(store.allowed("p1", "codex-computer")).toBe(false);
    expect(store.allowed("p2", "codex-chrome")).toBe(false);
    expect(new IntegrationConsentStore(memoryIo(state.contents).io).list("p1")).toEqual([
      "codex-chrome",
    ]);
  });

  it("revokes and persists the revocation", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io);
    store.allow("p1", "codex-chrome");
    store.revoke("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    expect(new IntegrationConsentStore(memoryIo(state.contents).io).list("p1")).toEqual([]);
    // Revoking nothing writes nothing.
    const writes = state.writes;
    store.revoke("p1", "codex-chrome");
    expect(state.writes).toBe(writes);
  });

  it("asks again once the disclosures the user saw have changed", () => {
    const stale = JSON.stringify({ p1: { "codex-chrome": "0".repeat(64) } });
    expect(new IntegrationConsentStore(memoryIo(stale).io).allowed("p1", "codex-chrome")).toBe(
      false,
    );
    const current = JSON.stringify({ p1: { "codex-chrome": disclosuresDigest("codex-chrome") } });
    expect(new IntegrationConsentStore(memoryIo(current).io).allowed("p1", "codex-chrome")).toBe(
      true,
    );
  });

  it("starts with no grants from a missing, corrupt or foreign file", () => {
    for (const contents of [undefined, "{", "[]", JSON.stringify({ p1: ["codex-chrome"] })])
      expect(new IntegrationConsentStore(memoryIo(contents).io).list("p1")).toEqual([]);
    const unknown = JSON.stringify({ p1: { "claude-chrome": disclosuresDigest("codex-chrome") } });
    expect(new IntegrationConsentStore(memoryIo(unknown).io).list("p1")).toEqual([]);
  });

  it("holds a grant for this run when it can't be saved", () => {
    const { io, state } = memoryIo();
    state.failWrites = true;
    const store = new IntegrationConsentStore(io);
    store.allow("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(true);
  });
});
