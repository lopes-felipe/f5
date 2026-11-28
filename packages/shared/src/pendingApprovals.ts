import {
  ApprovalRequestId,
  ProviderApprovalOption,
  ProviderApprovalPresentation,
  type ProviderRequestKind,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { compareActivities, pendingApprovalActivities } from "./pendingActivityWindow";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: ProviderRequestKind;
  appName?: string;
  approvalOptions?: ReadonlyArray<ProviderApprovalOption>;
  presentation?: ProviderApprovalPresentation;
  requestType?: string;
  createdAt: string;
  detail?: string;
  requestedPermissions?: Record<string, unknown>;
}

export function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permissions_approval":
      return "permission";
    default:
      return typeof requestType === "string" && requestType.trim().length > 0 ? "unknown" : null;
  }
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const pending: PendingApproval[] = [];
  const ordered = pendingApprovalActivities(activities.toSorted(compareActivities));

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change" ||
        payload.requestKind === "permission" ||
        payload.requestKind === "mcp-elicitation" ||
        payload.requestKind === "unknown")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const requestType =
      payload && typeof payload.requestType === "string" ? payload.requestType : undefined;
    const requestedPermissions = asUnknownRecord(payload?.requestedPermissions);

    if (requestId && requestKind) {
      const approvalOptions = Array.isArray(payload?.approvalOptions)
        ? payload.approvalOptions.filter(Schema.is(ProviderApprovalOption))
        : undefined;
      const presentation = Schema.decodeUnknownOption(ProviderApprovalPresentation)(
        payload?.presentation,
      );
      pending.push({
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(requestKind === "mcp-elicitation"
          ? {
              appName: typeof payload?.appName === "string" ? payload.appName : "MCP app",
              approvalOptions: approvalOptions ?? [],
            }
          : approvalOptions?.length
            ? { approvalOptions }
            : {}),
        ...(presentation._tag === "Some" ? { presentation: presentation.value } : {}),
        ...(requestKind === "unknown" && requestType ? { requestType } : {}),
        ...(detail ? { detail } : {}),
        ...(requestedPermissions ? { requestedPermissions } : {}),
      });
      continue;
    }
  }

  return pending.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
