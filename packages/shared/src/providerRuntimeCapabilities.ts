import { compareCodexCliVersions, parseCodexCliVersion } from "./codexCliVersion";
import {
  isKnownProviderKind,
  type ProviderRuntimeCapabilities,
  type ProviderSessionAction,
  type ProviderSessionCapabilities,
} from "@t3tools/contracts";
import { providerMaxImages } from "./attachmentLimits";

export function supportsCodexAsyncQuestions(version: string | null | undefined): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 153);
}

/** Native operations are enabled only on the runtime certified by the live spike. */
export function supportsCodexNativeOperations(version: string | null | undefined): boolean {
  const parsed = version ? parseCodexCliVersion(version) : null;
  return parsed !== null && compareCodexCliVersions(parsed, "0.162.0") >= 0;
}

export function providerRuntimeCapabilities(
  driver: string,
  version?: string | null,
): ProviderRuntimeCapabilities {
  const rollback = driver === "codex" || driver === "claudeAgent" || driver === "opencode";
  const codexNative = driver === "codex" && supportsCodexNativeOperations(version);
  return {
    nativeReview: codexNative,
    nativeCompaction: driver === "claudeAgent" || codexNative,
    nativeFork: driver === "claudeAgent" || codexNative,
    nativeGoals: codexNative,
    nativeAttachments: codexNative,
    childTaskInspection: driver === "claudeAgent" || codexNative,
    childTaskStop: driver === "claudeAgent",
    fileCheckpointing: driver === "claudeAgent",
    turnSteering: ["codex", "claudeAgent", "grok", "cursor", "antigravity"].includes(driver),
    conversationRollback: rollback,
    rollbackReadback: rollback,
    rollbackAffectsFiles: driver === "opencode",
    asyncQuestions: driver === "codex" && supportsCodexAsyncQuestions(version),
    maxImagesPerTurn: isKnownProviderKind(driver) ? providerMaxImages(driver) : 0,
    // Claude reports models through SDK initialization; Codex through `model/list`.
    reportedModels: driver === "claudeAgent" || driver === "codex",
    sessionCommandCatalog: driver === "claudeAgent" || driver === "codex" || driver === "grok",
    instanceInventory: driver === "claudeAgent" || driver === "codex",
    nativeSessionCleanup: driver === "claudeAgent",
  };
}

/**
 * Whether a session action is available. The session snapshot (when the thread
 * has one) is authoritative; otherwise the adapter-wide fallback decides.
 */
export function isSessionActionSupported(
  session: ProviderSessionCapabilities | null | undefined,
  action: ProviderSessionAction,
  fallback: boolean,
): boolean {
  const support = session?.actions.find((entry) => entry.action === action);
  return support ? support.supported : fallback;
}
