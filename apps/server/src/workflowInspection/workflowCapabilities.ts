/**
 * Computes a read-only stage's capabilities in ProviderService, so every
 * provider enforces the same decisions: which project connectors (and which of
 * their operations) are offered, and whether the host inspection server is
 * attached.
 *
 * Planning is pure and feeds the launch fingerprint. Granting issues the
 * inspection credential and happens only when a session actually starts, so
 * adopting a live session never revokes the credential it is using.
 */
import { createHash } from "node:crypto";

import type {
  ProjectId,
  ProviderKind,
  ProviderStartOptions,
  ServerSettings,
  ThreadId,
  WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { WorkflowCapabilityGrant } from "./capabilityPolicy.ts";
import { planWorkflowConnectors, type WorkflowConnectorGrant } from "./connectorRegistry.ts";
import type { InspectionMcpHttpServerShape } from "./InspectionMcpHttpServer.ts";

/** Bump when capability semantics change so sessions launched under older rules are recreated. */
export const WORKFLOW_CAPABILITY_VERSION = 1;

/** Providers that can attach the host inspection server and enforce the policy for it. */
export function providerSupportsInspectionServer(provider: ProviderKind): boolean {
  return provider === "claudeAgent" || provider === "codex" || provider === "opencode";
}

export interface WorkflowCapabilityPlan {
  readonly profile: WorkflowTurnExecutionProfile;
  /** Start options with project connectors narrowed to exposed operations. */
  readonly providerOptions: ProviderStartOptions;
  readonly connectors: Readonly<Record<string, WorkflowConnectorGrant>>;
  readonly attachInspection: boolean;
  /** Part of the launch fingerprint. */
  readonly digest: string;
}

export function planWorkflowCapabilities(input: {
  readonly settings: ServerSettings | null;
  readonly inspectionAvailable: boolean;
  readonly projectId?: ProjectId | undefined;
  readonly provider: ProviderKind;
  readonly cwd?: string | undefined;
  readonly profile?: WorkflowTurnExecutionProfile | undefined;
  readonly providerOptions: ProviderStartOptions | undefined;
}): WorkflowCapabilityPlan | undefined {
  if (!input.profile) return undefined;
  const trusted =
    input.projectId !== undefined
      ? input.settings?.projectSettingsOverrides[input.projectId]?.workflowTrustedConnectors
      : undefined;
  const connectors = planWorkflowConnectors({
    servers: input.providerOptions?.mcpServers,
    trusted,
  });
  const attachInspection =
    input.inspectionAvailable &&
    input.cwd !== undefined &&
    providerSupportsInspectionServer(input.provider);
  return {
    profile: input.profile,
    providerOptions: { ...input.providerOptions, mcpServers: connectors.servers },
    connectors: connectors.grants,
    attachInspection,
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          version: WORKFLOW_CAPABILITY_VERSION,
          connectors: connectors.digest,
          inspection: attachInspection,
        }),
      )
      .digest("hex"),
  };
}

export function grantWorkflowCapabilities(
  inspection: InspectionMcpHttpServerShape | null,
  plan: WorkflowCapabilityPlan,
  input: {
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
    readonly cwd?: string | undefined;
  },
): Effect.Effect<WorkflowCapabilityGrant> {
  return Effect.gen(function* () {
    const session =
      plan.attachInspection && inspection && input.cwd
        ? yield* inspection.createSession({
            threadId: input.threadId,
            projectId: input.projectId ?? null,
            profile: plan.profile,
            roots: [input.cwd],
            existingServerNames: new Set(Object.keys(plan.providerOptions.mcpServers ?? {})),
          })
        : null;
    return {
      profile: plan.profile,
      inspectionServerName: session?.serverName ?? null,
      inspection: session,
      connectors: plan.connectors,
    };
  });
}
