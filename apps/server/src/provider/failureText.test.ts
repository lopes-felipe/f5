import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { redactProviderFailureText, redactProviderRuntimeFailure } from "./failureText.ts";
import { AcpCredentialScrubber, redactAcpLogPayload } from "./acp/AcpNativeLogging.ts";

describe("provider failure credentials", () => {
  it("redacts compound JSON, assignment and header keys without hiding max_tokens", () => {
    expect(
      redactProviderFailureText(
        'client_secret=client-value refresh_token=refresh-value {"client_secret":"json-value"} clientSecret: camel-value X-Auth-Token: header-value max_tokens=4096',
      ),
    ).toBe(
      'client_secret=[REDACTED] refresh_token=[REDACTED] {"client_secret":"[REDACTED]"} clientSecret: [REDACTED] X-Auth-Token: [REDACTED] max_tokens=4096',
    );
    expect(redactProviderFailureText('{"refresh_token":"code value"}')).toBe(
      '{"refresh_token":"[REDACTED]"}',
    );
  });

  it("redacts whole underscore-containing keys in ACP diagnostics and traces", () => {
    const text = [
      "anthropic=sk-ant-api03-AbCdEf_GhIjKlMnOpQr-StUvWx_yz0123456789-AA",
      "openai=sk-proj-AbCdEfGhIj_KlMnOpQrStUv-WxYz_0123456789",
    ].join("\n");
    const expected = "anthropic=[redacted]\nopenai=[redacted]";
    expect(new AcpCredentialScrubber().scrub(text)).toBe(expected);
    expect(redactAcpLogPayload({ stderr: text })).toEqual({ stderr: expected });
  });

  it("scrubs URL secrets and authorization while preserving ordinary diagnostics", () => {
    const result = redactProviderFailureText(
      "https://user:pass@example.com/path?refresh_token=private Bearer abcdef Basic dXNlcjpwYXNz",
    );
    for (const secret of ["user", "pass", "private", "abcdef", "dXNlcjpwYXNz"])
      expect(result).not.toContain(secret);
    expect(redactProviderFailureText("Failure at https://example.com")).toBe(
      "Failure at https://example.com",
    );
    expect(
      JSON.parse(
        redactAcpLogPayload(
          JSON.stringify({
            message: "Bearer credential",
            status: "failed",
          }),
        ) as string,
      ),
    ).toEqual({ message: "Bearer [redacted]", status: "failed" });
  });

  it("scrubs persisted runtime error details and completed-turn errors", () => {
    const event = {
      type: "runtime.error",
      payload: {
        message: "clientSecret=private",
        detail: { code: '{"refresh_token":"private"}', client_secret: "private", max_tokens: 4096 },
      },
    } as unknown as ProviderRuntimeEvent;
    expect(redactProviderRuntimeFailure(event).payload).toEqual({
      message: "clientSecret=[REDACTED]",
      detail: {
        code: '{"refresh_token":"[REDACTED]"}',
        client_secret: "[REDACTED]",
        max_tokens: 4096,
      },
    });
    expect(
      redactProviderRuntimeFailure({
        ...event,
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "refresh_token=private" },
      } as ProviderRuntimeEvent).payload,
    ).toEqual({ state: "failed", errorMessage: "refresh_token=[REDACTED]" });
  });
});
