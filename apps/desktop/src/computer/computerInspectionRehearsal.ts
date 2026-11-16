import { randomUUID } from "node:crypto";
import type {
  ComputerAutomationRequest,
  ComputerAuthorization,
  ComputerInspectResult,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";

/** Reference and timed samples must differ only in correlation and deadline. */
export function computerInspectionRehearsalRequest(
  appId: string,
  maxNodes: number,
  authorization: ComputerAuthorization,
): ComputerAutomationRequest {
  return {
    op: "inspect",
    delivery: "background",
    appId,
    maxNodes,
    authorization,
    requestId: randomUUID(),
    payloadHash: "diagnostic",
    deadlineAtMs: Date.now() + 30_000,
    agent: { provider: "codex", threadTitle: "Background inspection diagnostic" },
  };
}

/** Compare complete inspection content while ignoring ephemeral element references. */
export function computerInspectionDigest(tree: ComputerInspectResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accessible: tree.accessible,
        truncated: tree.truncated ?? false,
        nodes: tree.nodes.map(({ elementRef: _ref, ...node }) => node),
      }),
    )
    .digest("hex");
}

/** Bounded report fields identify invalid samples without exposing UI content. */
export function computerInspectionSampleObservation(
  scenario: string,
  tree: ComputerInspectResult,
  expectedDigest: string,
) {
  const reason = tree.truncated
    ? "truncated"
    : !tree.accessible
      ? "inaccessible"
      : tree.nodes.length === 0
        ? "empty"
        : computerInspectionDigest(tree) !== expectedDigest
          ? "content-changed"
          : undefined;
  return {
    name: scenario + "." + (reason ?? "equivalent-complete"),
    actual: reason ? 1 : 0,
    maximum: 0,
    passed: !reason,
  };
}

/** Validate and forward deterministic fixture modes to the native launcher. */
export function computerFixturePerformanceArgs(options: {
  treeNodes?: number;
  delayedFocus?: boolean;
}): string[] {
  if (
    options.treeNodes !== undefined &&
    (!Number.isInteger(options.treeNodes) || options.treeNodes < 1 || options.treeNodes > 800)
  )
    throw new Error("Fixture treeNodes must be between 1 and 800.");
  return [
    ...(options.treeNodes === undefined ? [] : ["--tree-nodes", String(options.treeNodes)]),
    ...(options.delayedFocus ? ["--delayed-focus"] : []),
  ];
}
