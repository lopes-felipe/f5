import { describe, expect, it } from "vitest";
import {
  parseOtelAttributes,
  publicOtlpConfiguration,
  resolveOtlpConfiguration,
} from "./observability";

describe("OTLP configuration", () => {
  it("uses settings before signal environment before the shared base endpoint", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test/base/",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/direct",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20env",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    };
    expect(resolveOtlpConfiguration({}, env)).toMatchObject({
      traces: { url: "https://traces.test/direct", source: "environment" },
      metrics: { url: "https://collector.test/base/v1/metrics", protocol: "http/json" },
    });
    expect(
      resolveOtlpConfiguration(
        {
          otlpTracesUrl: "https://settings.test/trace",
          otlpHeaders: [{ name: "authorization", value: "Bearer stored" }],
        },
        env,
      ).traces,
    ).toMatchObject({
      url: "https://settings.test/trace",
      source: "settings",
      headers: { authorization: "Bearer stored" },
    });
  });
  it("normalizes header names before applying signal and settings precedence", () => {
    const config = resolveOtlpConfiguration(
      { otlpHeaders: [{ name: "AUTHORIZATION", value: "stored" }] },
      {
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=global",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=signal",
      },
    );
    expect(config.traces.headers).toEqual({ authorization: "stored" });
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
      resolveOtlpConfiguration(
        {},
        { OTEL_EXPORTER_OTLP_HEADERS: "Host=evil,authorization=bad%0d%0aInjected%3A%20header" },
      ).traces.headers,
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
