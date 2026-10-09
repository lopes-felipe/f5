import { describe, expect, it } from "vitest";
import {
  providerRuntimeCapabilities,
  supportsCodexAsyncQuestions,
} from "./providerRuntimeCapabilities";
describe("runtime capabilities", () => {
  it("gates message questions by the Codex version", () => {
    for (const version of [undefined, "unknown", "codex 0.152.9"])
      expect(supportsCodexAsyncQuestions(version)).toBe(false);
    for (const version of ["codex 0.153.0", "v0.154.1", "1.0.0"])
      expect(supportsCodexAsyncQuestions(version)).toBe(true);
    expect(providerRuntimeCapabilities("claudeAgent", "1.0.0").asyncQuestions).toBe(false);
  });
  it("does not advertise unreliable rollback or unsupported steering", () => {
    for (const driver of ["grok", "cursor", "antigravity"])
      expect(providerRuntimeCapabilities(driver).rollbackReadback).toBe(false);
    expect(providerRuntimeCapabilities("opencode")).toMatchObject({
      turnSteering: false,
      conversationRollback: true,
      rollbackAffectsFiles: true,
    });
    expect(providerRuntimeCapabilities("unknown").maxImagesPerTurn).toBe(0);
  });
});

it("gates the certified Codex native operations at 0.160.1", () => {
  for (const version of [undefined, "unknown", "0.147.0", "0.156.1", "0.160.0", "0.160.1-beta.1"])
    expect(providerRuntimeCapabilities("codex", version).nativeReview).toBe(false);
  for (const version of ["codex 0.160.1", "0.161.0", "1.0.0"])
    expect(providerRuntimeCapabilities("codex", version)).toMatchObject({
      nativeReview: true,
      nativeGoals: true,
      nativeAttachments: true,
      nativeCompaction: true,
      nativeFork: true,
    });
});
