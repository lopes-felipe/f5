export interface OtlpHeader {
  readonly name: string;
  readonly value: string;
  readonly valueRedacted?: boolean;
}
export interface OtlpSettings {
  readonly otlpTracesUrl?: string;
  readonly otlpMetricsUrl?: string;
  readonly otlpHeaders?: ReadonlyArray<OtlpHeader>;
}
export interface OtlpSignalConfiguration {
  readonly url: string | null;
  /** `secret-unavailable`: a stored header's secret is missing, so nothing is exported. */
  readonly source: "disabled" | "settings" | "environment" | "unset" | "secret-unavailable";
  readonly protocol: "http/json" | "http/protobuf";
  readonly headers: Readonly<Record<string, string>>;
}
const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
export function parseOtelAttributes(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of (value ?? "").split(",").slice(0, 100)) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = decode(entry.slice(0, separator).trim());
    const text = decode(entry.slice(separator + 1).trim());
    if (key.length <= 128 && text.length <= 4096)
      Object.defineProperty(result, key, { value: text, enumerable: true, configurable: true });
  }
  return result;
}
export function resolveOtlpConfiguration(
  settings: OtlpSettings = {},
  env: Readonly<Record<string, string | undefined>> = {},
): {
  traces: OtlpSignalConfiguration;
  metrics: OtlpSignalConfiguration;
  attributes: Readonly<Record<string, string>>;
} {
  const signal = (kind: "traces" | "metrics"): OtlpSignalConfiguration => {
    const prefix = `OTEL_EXPORTER_OTLP_${kind.toUpperCase()}`;
    const exporter = env[`OTEL_${kind.toUpperCase()}_EXPORTER`]?.trim().toLowerCase();
    const disabled = env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true" || exporter === "none";
    const configured = (
      kind === "traces" ? settings.otlpTracesUrl : settings.otlpMetricsUrl
    )?.trim();
    const explicit = env[`${prefix}_ENDPOINT`]?.trim();
    const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    const candidate =
      configured || explicit || (base ? `${base.replace(/\/+$/, "")}/v1/${kind}` : "");
    const protocol =
      env[`${prefix}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
    let url: string | null = null;
    try {
      const parsed = new URL(candidate);
      if (
        !parsed.username &&
        !parsed.password &&
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.hash &&
        ["http/json", "http/protobuf"].includes(protocol)
      )
        url = parsed.href;
    } catch {
      /* An invalid destination disables this signal. */
    }
    const normalizedHeaders = (value: string | undefined) =>
      Object.fromEntries(
        Object.entries(parseOtelAttributes(value)).map(([name, text]) => [
          name.toLowerCase(),
          text,
        ]),
      );
    const headers = {
      ...normalizedHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...normalizedHeaders(env[`${prefix}_HEADERS`]),
    };
    for (const entry of settings.otlpHeaders ?? []) headers[entry.name.toLowerCase()] = entry.value;
    for (const [key, value] of Object.entries(headers))
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) ||
        /[\r\n]/.test(value) ||
        ["host", "content-length", "connection"].includes(key.toLowerCase())
      )
        delete headers[key];
    // Exporting without a header the collector expects could send data unauthenticated.
    if (
      !disabled &&
      url &&
      settings.otlpHeaders?.some((entry) => entry.valueRedacted && !entry.value)
    )
      return { url: null, source: "secret-unavailable", protocol: "http/protobuf", headers: {} };
    return {
      url: disabled ? null : url,
      source: disabled ? "disabled" : !url ? "unset" : configured ? "settings" : "environment",
      protocol: protocol === "http/json" ? "http/json" : "http/protobuf",
      headers,
    };
  };
  return {
    traces: signal("traces"),
    metrics: signal("metrics"),
    attributes: parseOtelAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
  };
}

/** Safe to expose to the browser: no headers, URL credentials, query strings or resource attributes. */
export function publicOtlpConfiguration(
  configuration: ReturnType<typeof resolveOtlpConfiguration>,
) {
  const signal = ({ url, source, protocol }: OtlpSignalConfiguration) => {
    const safe = url ? new URL(url) : null;
    return { endpoint: safe ? `${safe.origin}${safe.pathname}` : null, source, protocol };
  };
  return { traces: signal(configuration.traces), metrics: signal(configuration.metrics) };
}
