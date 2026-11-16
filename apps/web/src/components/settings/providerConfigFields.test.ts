import { describe, expect, it } from "vitest";
import { decodeDriverConfigField, readDriverConfigField } from "./providerConfigFields";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { AcpSettings, ProviderDriverKind } from "@t3tools/contracts";
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
});
