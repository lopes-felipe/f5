import { describe, expect, it } from "vitest";

import { isScrubExemptField, REDACTED, scrubSecretsInText } from "./logSecretScrub.ts";

// Assembled at runtime so secret scanners do not flag the fixtures.
const fake = (...parts: string[]) => parts.join("");

describe("scrubSecretsInText", () => {
  it.each([
    ["Anthropic key", fake("sk-ant-api03-", "Ab3dEfGh1jKlMnOpQrStUvWxYz012345")],
    ["OpenAI project key", fake("sk-proj-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4")],
    ["GitHub token", fake("ghp_", "a".repeat(30), "123456")],
    ["GitHub app token", fake("ghs_", "B".repeat(36))],
    ["fine-grained GitHub token", fake("github_pat_", "11ABCDEFG0", "x".repeat(40))],
    ["GitLab token", fake("glpat-", "abcdefghij0123456789")],
    ["Slack token", fake("xoxb-", "1234567890-abcdef")],
    ["AWS access key", fake("AKIA", "IOSFODNN7EXAMPLE")],
    ["Google API key", fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q")],
    [
      "JWT",
      fake(
        "eyJhbGciOiJIUzI1NiJ9",
        ".",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".",
        "dozjgNryP4J3jVmNHl0w5N",
      ),
    ],
  ])("redacts a %s", (_label, secret) => {
    const scrubbed = scrubSecretsInText(`export TOKEN=${secret} # set`);
    expect(scrubbed).toBe(`export TOKEN=${REDACTED} # set`);
  });

  it("keeps the authorization scheme and redacts its credential", () => {
    expect(scrubSecretsInText("Authorization: Bearer abcDEF123456ghiJKL789")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(scrubSecretsInText("-H 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=='")).toBe(
      `-H 'Authorization: Basic ${REDACTED}'`,
    );
  });

  it.each([
    ["short Basic credential", "Authorization: Basic dTpw", `Authorization: Basic ${REDACTED}`],
    [
      "Bearer token without digits",
      "authorization: bearer abcdefghijklmnopqrstuv",
      `authorization: bearer ${REDACTED}`,
    ],
    ["uppercase scheme", "AUTHORIZATION: BEARER abc", `AUTHORIZATION: BEARER ${REDACTED}`],
    [
      "JSON header",
      '{"Authorization": "Bearer opaque.token"}',
      `{"Authorization": "Bearer ${REDACTED}"}`,
    ],
    ["bare header value", "Authorization: 0123456789abcdefXYZ", `Authorization: ${REDACTED}`],
    [
      "uppercase scheme in prose",
      "send BEARER abcDEF123456ghiJKL789 now",
      `send BEARER ${REDACTED} now`,
    ],
  ])("redacts an Authorization credential: %s", (_label, text, expected) => {
    expect(scrubSecretsInText(text)).toBe(expected);
  });

  it("redacts credentials embedded in URLs but keeps the host and path", () => {
    expect(
      scrubSecretsInText("remote: https://x-access-token:s3cr3tValue@github.com/org/repo.git"),
    ).toBe(`remote: https://${REDACTED}@github.com/org/repo.git`);
    expect(scrubSecretsInText("postgres://app:hunter2@db.internal:5432/main")).toBe(
      `postgres://${REDACTED}@db.internal:5432/main`,
    );
  });

  it("redacts a whole PEM private key block", () => {
    const pem = [
      fake("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      fake("-----END OPENSSH ", "PRIVATE KEY-----"),
    ].join("\n");
    expect(scrubSecretsInText(`key:\n${pem}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
  });

  it.each([
    "const token = process.env.GITHUB_TOKEN;",
    "password: ${{ secrets.DB_PASSWORD }}",
    "id 0b7f2c4e-8a1d-4c3e-9f6a-2d5b7e9c1a3f",
    "git@github.com:org/repo.git and ssh://git@github.com/org/repo",
    "https://user@example.com/path and http://localhost:3000/a@b",
    "Basic authentication is configured by the reverse proxy",
    "the task-runner-orchestration-module and risk-assessment-framework",
    "Bearer tokens expire after an hour",
    "sha256-q2V5c2lnbmF0dXJlYmFzZTY0ZW5jb2RlZHZhbHVl",
    'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com',
    "Authorization: Bearer ${{ secrets.TOKEN }}",
    "Authorization: the request must carry a session cookie",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(scrubSecretsInText(text)).toBe(text);
  });
});

describe("isScrubExemptField", () => {
  it("exempts signatures, identifiers and redacted thinking payloads", () => {
    expect(isScrubExemptField({ type: "thinking" }, "signature")).toBe(true);
    expect(isScrubExemptField({}, "id")).toBe(true);
    expect(isScrubExemptField({}, "tool_use_id")).toBe(true);
    expect(isScrubExemptField({}, "threadId")).toBe(true);
    expect(isScrubExemptField({ type: "redacted_thinking" }, "data")).toBe(true);
  });

  it("exempts signed thinking text, which the API verifies against its signature", () => {
    expect(isScrubExemptField({ type: "thinking" }, "thinking")).toBe(true);
    expect(isScrubExemptField({ type: "thinking_delta" }, "thinking")).toBe(true);
    expect(isScrubExemptField({ type: "text" }, "thinking")).toBe(false);
  });

  it("scrubs other fields", () => {
    expect(isScrubExemptField({ type: "text" }, "data")).toBe(false);
    expect(isScrubExemptField({}, "text")).toBe(false);
    expect(isScrubExemptField({}, "valid")).toBe(false);
    expect(isScrubExemptField({}, "paid")).toBe(false);
  });
});
