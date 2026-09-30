import { isKnownProviderKind, type ProviderRuntimeCapabilities } from "@t3tools/contracts";
import { providerMaxImages } from "./attachmentLimits";

export function supportsCodexAsyncQuestions(version: string | null | undefined): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 153);
}

export function providerRuntimeCapabilities(
  driver: string,
  version?: string | null,
): ProviderRuntimeCapabilities {
  const rollback = driver === "codex" || driver === "claudeAgent" || driver === "opencode";
  return {
    turnSteering: ["codex", "claudeAgent", "grok", "cursor", "antigravity"].includes(driver),
    conversationRollback: rollback,
    rollbackReadback: rollback,
    rollbackAffectsFiles: driver === "opencode",
    asyncQuestions: driver === "codex" && supportsCodexAsyncQuestions(version),
    maxImagesPerTurn: isKnownProviderKind(driver) ? providerMaxImages(driver) : 0,
  };
}
