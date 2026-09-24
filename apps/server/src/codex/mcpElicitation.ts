import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function persistence(value: unknown): "acceptForSession" | "acceptAlways" | undefined {
  if (typeof value !== "string") return undefined;
  if (/session/i.test(value)) return "acceptForSession";
  if (/always|permanent|forever|persistent/i.test(value)) return "acceptAlways";
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

function persistenceField(key: string, field: Record<string, unknown>) {
  return (
    key === "persist" ||
    persistence(key) !== undefined ||
    persistence(field.title) !== undefined ||
    persistence(field.description) !== undefined
  );
}

/** Build only representable approval forms. Arbitrary inputs and URL elicitations fail closed. */
export function mcpElicitationResponse(
  payload: unknown,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  if (decision === "cancel" || decision === "decline") return { action: decision };
  const request = record(payload);
  const form = record(request?.requestedSchema);
  if (request?.mode === "url" || !form || form.type !== "object") return { action: "decline" };
  const fields = record(form.properties) ?? {};
  const metadata = record(request?._meta);
  const advertisedPersistence = Array.isArray(metadata?.persist)
    ? metadata.persist
    : [metadata?.persist];
  let represented =
    decision === "accept" ||
    advertisedPersistence.some((value) => persistence(value) === decision) ||
    (decision === "acceptAlways" && metadata?.allowPersistentApproval === true);
  const content: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    const field = record(value);
    if (!field) return { action: "decline" };
    const choices = options(field);
    const choice = choices.find((item) =>
      decision === "accept"
        ? /once|accept|approve|allow/i.test(item.value) && persistence(item.value) === undefined
        : persistence(item.value) === decision,
    );
    if (choice) {
      content[key] = choice.value;
      represented = true;
    } else if (field.type === "boolean" && persistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
      if (decision === "acceptAlways") represented = true;
    } else if (
      field.default !== undefined &&
      field.default !== null &&
      !persistence(field.default)
    ) {
      const defaultValue = field.default;
      const valid = choices.length
        ? choices.some((item) => item.value === defaultValue)
        : field.type === "integer"
          ? Number.isInteger(defaultValue)
          : ["boolean", "string", "number"].includes(String(field.type)) &&
            typeof defaultValue === field.type;
      if (valid) content[key] = defaultValue;
    }
  }
  if (
    !represented ||
    (Array.isArray(form.required) &&
      form.required.some((key) => typeof key !== "string" || !Object.hasOwn(content, key)))
  )
    return { action: "decline" };
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
