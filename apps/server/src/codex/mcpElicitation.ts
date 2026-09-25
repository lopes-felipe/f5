import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function persistence(value: unknown): "acceptForSession" | "acceptAlways" | undefined {
  if (typeof value !== "string") return undefined;
  if (/^(?:session|allow_session|accept_for_session|this session)$/i.test(value))
    return "acceptForSession";
  if (/^(?:always|allow_always|permanent|forever|persistent)$/i.test(value)) return "acceptAlways";
  return undefined;
}

function options(field: Record<string, unknown>): { value: string; label?: string }[] {
  if (Array.isArray(field.oneOf))
    return field.oneOf.flatMap((value) => {
      const item = record(value);
      return typeof item?.const === "string"
        ? [{ value: item.const, ...(typeof item.title === "string" ? { label: item.title } : {}) }]
        : [];
    });
  return Array.isArray(field.enum)
    ? field.enum.flatMap((value, index) =>
        typeof value === "string"
          ? [
              {
                value,
                ...(Array.isArray(field.enumNames) && typeof field.enumNames[index] === "string"
                  ? { label: field.enumNames[index] }
                  : {}),
              },
            ]
          : [],
      )
    : [];
}

/** Only consent controls are representable by the approval UI; no hidden data/defaults. */
export function mcpElicitationResponse(
  payload: unknown,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  if (decision === "cancel" || decision === "decline") return { action: decision };
  const reject = { action: "decline" };
  const request = record(payload);
  const form = record(request?.requestedSchema);
  if (request?.mode === "url" || !form || form.type !== "object") return reject;
  const fields = record(form.properties) ?? {};
  const metadata = record(request?._meta);
  const advertised = Array.isArray(metadata?.persist) ? metadata.persist : [metadata?.persist];
  const metadataAllows =
    advertised.some((value) => persistence(value) === decision) ||
    (decision === "acceptAlways" && metadata?.allowPersistentApproval === true);
  const content: Record<string, unknown> = Object.create(null);
  let represented = false;
  for (const [key, value] of Object.entries(fields)) {
    const field = record(value);
    if (!field) return reject;
    const choices = options(field);
    if (
      field.type === "string" &&
      /^(?:scope|consent|approval|permission|persist)$/i.test(key) &&
      choices.length
    ) {
      const choice = choices.find(({ value }) =>
        decision === "accept"
          ? /^(?:once|allow_once|accept_once|approve_once|accept|approve|allow)$/i.test(value)
          : persistence(value) === decision,
      );
      if (!choice) return reject;
      content[key] = choice.value;
      represented = true;
    } else if (
      field.type === "boolean" &&
      /^(?:persist|session|always|allow_session|allow_always)$/i.test(key)
    ) {
      const level =
        persistence(key) ??
        persistence(field.title) ??
        (key === "persist" && metadata?.allowPersistentApproval === true
          ? "acceptAlways"
          : undefined);
      if (!level || (decision !== "accept" && decision !== level)) return reject;
      content[key] = decision === level;
      represented = true;
    } else {
      // Even optional fields must be visible and understood before sending their values.
      return reject;
    }
  }
  if (Object.keys(fields).length === 0) {
    represented =
      typeof request?.message === "string" && /^Allow ChatGPT to use .+\?$/i.test(request.message);
    if (decision !== "accept" && !metadataAllows) return reject;
  }
  if (
    !represented ||
    (Array.isArray(form.required) &&
      form.required.some((key) => typeof key !== "string" || !Object.hasOwn(content, key)))
  )
    return reject;
  return {
    action: "accept",
    content,
    ...(decision !== "accept"
      ? { _meta: { persist: decision === "acceptForSession" ? "session" : "always" } }
      : {}),
  };
}

export function describeMcpElicitation(payload: unknown): {
  appName: string;
  approvalOptions: ReadonlyArray<ProviderApprovalOption>;
} {
  const request = record(payload);
  const metadata = record(request?._meta);
  const candidates = [
    metadata?.app_name,
    metadata?.appName,
    metadata?.app,
    record(metadata?.target)?.app,
    record(metadata?.target)?.name,
    record(metadata?.tool_params)?.app_name,
    record(metadata?.tool_params)?.app,
    typeof request?.message === "string"
      ? /^Allow ChatGPT to use (.+?)\?$/i.exec(request.message)?.[1]
      : undefined,
    metadata?.connector_name,
    metadata?.connectorName,
    request?.serverName,
  ];
  const appName =
    candidates
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? "MCP app";
  const approvals: ProviderApprovalOption[] = [
    { decision: "acceptForSession", label: "Always allow this session" },
    { decision: "acceptAlways", label: "Always allow" },
    { decision: "accept", label: "Approve once" },
  ];
  return {
    appName,
    approvalOptions: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...approvals.filter(
        (option) => mcpElicitationResponse(payload, option.decision).action === "accept",
      ),
    ],
  };
}
