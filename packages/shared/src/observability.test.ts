import { describe, expect, it } from "vitest";
import {
  ignoredOtlpEnvironment,
  parseOtelAttributes,
  publicOtlpConfiguration,
  resolveOtlpConfiguration,
} from "./observability";

describe("OTLP configuration", () => {
  const inheritedEnv = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test/base/",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/direct",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20env",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-signal=env",
    OTEL_RESOURCE_ATTRIBUTES: "host.name=corp-laptop,team=platform",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
  };
  it("never exports to an endpoint or with headers inherited from the environment", () => {
    const config = resolveOtlpConfiguration({}, inheritedEnv);
    expect(config).toMatchObject({
      traces: { url: null, source: "unset", headers: {} },
      metrics: { url: null, source: "unset", headers: {} },
    });
  });
  it("names the ignored endpoint and header variables so users can be told", () => {
    expect(ignoredOtlpEnvironment(inheritedEnv)).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ]);
    expect(ignoredOtlpEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: " " })).toEqual([]);
  });
  it("exports only to the Settings collector, with only the Settings headers", () => {
    const config = resolveOtlpConfiguration(
      {
        otlpTracesUrl: "https://settings.test/trace",
        otlpMetricsUrl: "https://settings.test/metrics",
        otlpHeaders: [{ name: "AUTHORIZATION", value: "Bearer stored" }],
      },
      inheritedEnv,
    );
    expect(config.traces).toMatchObject({
      url: "https://settings.test/trace",
      source: "settings",
      headers: { authorization: "Bearer stored" },
    });
    expect(config.traces.headers).toEqual({ authorization: "Bearer stored" });
    // The environment may still choose the wire format of the Settings collector.
    expect(config.metrics).toMatchObject({
      url: "https://settings.test/metrics",
      protocol: "http/json",
    });
    // Resource attributes label the Settings collector's data, so a masked host name holds.
    expect(config.attributes).toEqual({ "host.name": "corp-laptop", team: "platform" });
  });
  it.each(["traces", "metrics"] as const)("honors the %s kill switch over settings", (kind) => {
    const configured = {
      otlpTracesUrl: "https://collector.test/traces",
      otlpMetricsUrl: "https://collector.test/metrics",
    };
    expect(
      resolveOtlpConfiguration(configured, { [`OTEL_${kind.toUpperCase()}_EXPORTER`]: "none" })[
        kind
      ],
    ).toMatchObject({ url: null, source: "disabled" });
    expect(resolveOtlpConfiguration(configured, { OTEL_SDK_DISABLED: "true" })).toMatchObject({
      traces: { url: null },
      metrics: { url: null },
    });
  });
  it.each(["ftp://collector.test", "https://user:secret@collector.test", "not a URL"])(
    "rejects unsafe destination %s",
    (url) => {
      expect(resolveOtlpConfiguration({ otlpTracesUrl: url }).traces.url).toBeNull();
    },
  );
  it("ignores malformed resource attributes and rejects unsafe headers", () => {
    expect(parseOtelAttributes("service.name=f5,broken,region=eu%20west,bad=%oops")).toEqual({
      "service.name": "f5",
      region: "eu west",
      bad: "%oops",
    });
    expect(
      resolveOtlpConfiguration({
        otlpTracesUrl: "https://collector.test/traces",
        otlpHeaders: [
          { name: "Host", value: "evil" },
          { name: "authorization", value: "bad\r\nInjected: header" },
        ],
      }).traces.headers,
    ).toEqual({});
  });
  it("never exposes header credentials or endpoint queries in public diagnostics", () => {
    const summary = publicOtlpConfiguration(
      resolveOtlpConfiguration({
        otlpTracesUrl: "https://collector.test/traces?token=private",
        otlpHeaders: [{ name: "Authorization", value: "Bearer private" }],
      }),
    );
    expect(summary.traces.endpoint).toBe("https://collector.test/traces");
    expect(JSON.stringify(summary)).not.toContain("private");
  });
});
