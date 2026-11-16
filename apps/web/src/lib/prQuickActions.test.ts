import { expect, it } from "vitest";
import { forgeCapabilitiesFor } from "@t3tools/shared/forgeCapabilities";
import { prQuickActions } from "./prQuickActions";
it("uses shared forge capabilities and narrows them for the current state", () => {
  expect(prQuickActions({ provider: "unknown", state: "open" })).toEqual([]);
  expect(prQuickActions({ provider: "bitbucket", state: "open" })).toEqual(["close"]);
  expect(prQuickActions({ provider: "bitbucket", state: "closed" })).toEqual([]);
  expect(prQuickActions({ provider: "github", state: "merged" })).toEqual([]);
  expect(prQuickActions({ provider: "github", state: "closed" })).toEqual(["reopen"]);
  expect(prQuickActions({ provider: "github", state: "open", isDraft: true })).toEqual([
    "ready",
    "close",
  ]);
  expect(prQuickActions({ provider: "github", repositoryArchived: true })).toEqual([]);
});
it("retains narrower server-reported capabilities instead of falling back to host defaults", () => {
  const caps = { ...forgeCapabilitiesFor("github")!, actions: [] };
  expect(prQuickActions({ provider: "github", state: "open", forgeCapabilities: caps })).toEqual(
    [],
  );
  expect(
    prQuickActions({
      provider: "gitlab",
      state: "open",
      forgeCapabilities: { ...caps, actions: ["close"] },
    }),
  ).toEqual(["close"]);
});
