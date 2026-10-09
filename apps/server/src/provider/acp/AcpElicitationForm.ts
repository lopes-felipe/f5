import type { ElicitationDescriptor } from "@t3tools/contracts";
import {
  buildElicitationDescriptor,
  type ElicitationResult,
} from "@t3tools/shared/elicitationForm";
import type {
  ElicitationContentValue,
  ElicitationRequest,
  ElicitationResponse,
} from "effect-acp/schema";
import type { ElicitationResponse as PrivateElicitationResponse } from "../elicitationRegistry.ts";

export type AcpElicitationResponse = ElicitationResponse;

/** Describes an ACP elicitation with the shared, provider-neutral form engine. */
export function acpElicitationDescriptor(
  request: ElicitationRequest,
): ElicitationResult<ElicitationDescriptor> {
  return request.mode === "url"
    ? buildElicitationDescriptor({
        mode: "url",
        message: request.message,
        nativeId: request.elicitationId,
        url: request.url,
      })
    : buildElicitationDescriptor({
        mode: "form",
        message: request.message,
        title: request.requestedSchema.title,
        requestedSchema: request.requestedSchema,
      });
}

/** Maps an already-validated private answer onto the ACP response shape. */
export function acpElicitationResponse(response: PrivateElicitationResponse): ElicitationResponse {
  if (response.action !== "accept") return { action: { action: response.action } };
  const content: Record<string, ElicitationContentValue> = Object.create(null);
  for (const [key, value] of Object.entries(response.content ?? {})) content[key] = value;
  return { action: { action: "accept", content } };
}
