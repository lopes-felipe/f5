import { describe, expect, it } from "vitest";
import { decodeDriverConfigField, readDriverConfigField } from "./providerConfigFields";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import {
  AcpSettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  MuseSettings,
  OpenCodeSettings,
  PiSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { Schema } from "effect";
const fields = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acp")]!.fields;
describe("custom ACP settings", () => {
  it("round trips typed arguments and environment without shell splitting", () => {
    const values = [
      "/custom/agent",
      '["--acp","two words","$(echo literal)"]',
      '{"AGENT_HOME":"/private/home"}',
    ];
    const config = Object.fromEntries(
      fields.map((field, i) => [field.key, decodeDriverConfigField(field, values[i]!)]),
    );
    expect(Schema.decodeUnknownSync(AcpSettings)(config)).toMatchObject({
      command: "/custom/agent",
      args: ["--acp", "two words", "$(echo literal)"],
      env: { AGENT_HOME: "/private/home" },
    });
    expect(readDriverConfigField(config, fields[1]!)).toBe(values[1]);
    expect(readDriverConfigField(config, fields[2]!)).toBe(values[2]);
  });
  it.each(['"--acp"', "[1]", "[null]", '["bad\\u0000arg"]', "[] trailing"])(
    "rejects invalid arguments: %s",
    (value) => {
      expect(() => decodeDriverConfigField(fields[1]!, value)).toThrow("JSON array");
    },
  );
  it.each(["[]", '{"BAD=KEY":"value"}', '{"KEY":null}', '{"KEY":1}', '{"KEY":"bad\\u0000value"}'])(
    "rejects invalid environment: %s",
    (value) => {
      expect(() => decodeDriverConfigField(fields[2]!, value)).toThrow("JSON object");
    },
  );
  it("requires a command, while empty optional fields use driver defaults", () => {
    expect(() => decodeDriverConfigField(fields[0]!, " ")).toThrow("required");
    expect(decodeDriverConfigField(fields[1]!, "")).toBeUndefined();
    expect(decodeDriverConfigField(fields[2]!, "{}")).toEqual({});
    expect(decodeDriverConfigField(fields[1]!, "[]")).toEqual([]);
  });

  it("validates the command against the ACP settings schema", () => {
    expect(() => decodeDriverConfigField(fields[0]!, "a".repeat(4097))).toThrow(
      "Invalid value for Command.",
    );
    expect(() => decodeDriverConfigField(fields[0]!, "/custom/\0agent")).toThrow(
      "Invalid value for Command.",
    );
  });
});

it("validates typed Pi launch arguments against the Pi settings schema", () => {
  const launchArgs = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")]!.fields.find(
    (field) => field.key === "launchArgs",
  )!;
  expect(() => decodeDriverConfigField(launchArgs, "x".repeat(32 * 1024 + 1))).toThrow(
    "Invalid value for Launch arguments.",
  );
  expect(decodeDriverConfigField(launchArgs, " --provider vendor ")).toBe("--provider vendor");
  expect(decodeDriverConfigField(launchArgs, " ")).toBeUndefined();
});

const driverSchemas: Readonly<
  Partial<Record<string, { fields: Readonly<Record<string, unknown>> }>>
> = {
  acp: AcpSettings,
  antigravity: AntigravitySettings,
  claudeAgent: ClaudeSettings,
  codex: CodexSettings,
  cursor: CursorSettings,
  grok: GrokSettings,
  muse: MuseSettings,
  opencode: OpenCodeSettings,
  pi: PiSettings,
};

it.each(DRIVER_OPTIONS)("uses the server field schemas for $label", (driver) => {
  const schema = driverSchemas[driver.value];
  expect(schema).toBeDefined();
  for (const field of driver.fields) {
    expect(field.schema, field.key).toBe(schema?.fields[field.key]);
  }
});
