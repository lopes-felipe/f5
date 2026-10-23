import { userInfo } from "node:os";
import { AGENT_AUTOMATION_SUPPORT } from "@t3tools/shared/agentAutomationSupport";
import { inspectCodexComputer, type CodexInspectionIo } from "./codexNativeIntegrations";

export interface BuiltinAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly version?: string;
}

/** Read-only identity probe. Installation is not certification: selection also requires
 * a certified record. It never enables plugins or imports a user's provider home. */
export async function probeComputerBuiltin(input: {
  provider: "claude" | "codex";
  platform: string;
  arch?: string;
  chatGptApp?: string;
  userHome?: string;
  io?: CodexInspectionIo;
}): Promise<BuiltinAvailability> {
  if (input.platform !== "darwin")
    return {
      available: false,
      reason: "Provider built-in computer control is unsupported on this platform",
    };
  if (input.provider === "claude")
    return {
      available: false,
      reason: AGENT_AUTOMATION_SUPPORT.claudeAgent.builtin!,
    };
  const inspected = await inspectCodexComputer({
    platform: input.platform,
    ...(input.arch ? { arch: input.arch } : {}),
    ...(input.chatGptApp ? { chatGptApp: input.chatGptApp } : {}),
    userHome: input.userHome ?? userInfo().homedir,
    ...(input.io ? { io: input.io } : {}),
  });
  return inspected.available
    ? { available: true, version: inspected.version }
    : { available: false, reason: inspected.reason };
}
