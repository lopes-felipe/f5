import { describe, expect, it } from "vitest";
import {
  buildElicitationDescriptor,
  normalizeElicitationSchema,
  validateElicitationContent,
} from "./elicitationForm";

const schema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", minLength: 2, maxLength: 20 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    ratio: { type: "number" },
    subscribe: { type: "boolean", default: false },
    plan: { type: "string", enum: ["free", "pro"], enumNames: ["Free", "Pro"] },
    tier: { type: "string", oneOf: [{ const: "a", title: "Tier A" }, { const: "b" }] },
    tags: {
      type: "array",
      items: { type: "string", enum: ["x", "y", "z"] },
      minItems: 1n,
      maxItems: 2,
    },
  },
  required: ["name", "plan"],
};

describe("elicitation form engine", () => {
  it("normalizes every supported field type with visible suggestions only", () => {
    const result = normalizeElicitationSchema(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((field) => [field.key, field.type, field.required])).toEqual([
      ["name", "string", true],
      ["email", "string", false],
      ["age", "integer", false],
      ["ratio", "number", false],
      ["subscribe", "boolean", false],
      ["plan", "enum", true],
      ["tier", "enum", false],
      ["tags", "multiselect", false],
    ]);
    expect(result.value[4]?.suggestedValue).toBe(false);
    expect(result.value[5]?.options).toEqual([
      { value: "free", label: "Free" },
      { value: "pro", label: "Pro" },
    ]);
    expect(result.value[6]?.options?.[0]).toEqual({ value: "a", label: "Tier A" });
    expect(result.value[7]?.minItems).toBe(1);
  });

  it.each([
    [{ type: "object", properties: { a: { type: "string", pattern: "^x$" } } }, "pattern"],
    [{ type: "object", properties: { a: { type: "object" } } }, "unsupported input type"],
    [{ type: "object", properties: { a: { type: "string", format: "ipv4" } } }, "format"],
    [{ type: "object", properties: {}, required: ["missing"] }, "does not define"],
    [
      { type: "object", properties: { a: { type: "string", minLength: 3, maxLength: 1 } } },
      "bounds",
    ],
    [{ type: "object", additionalProperties: false, properties: {} }, "additionalProperties"],
    [{ type: "object", properties: { a: { type: "string", enum: ["", "x"] } } }, "empty choice"],
    [
      {
        type: "object",
        properties: { a: { type: "string", oneOf: [{ const: "", title: "None" }] } },
      },
      "empty choice",
    ],
    [
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`f${index}`, { type: "boolean" }]),
        ),
      },
      "more than 32",
    ],
  ])("refuses unsupported schemas visibly (%#)", (input, reason) => {
    const result = normalizeElicitationSchema(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("validates content strictly and never fills omitted fields", () => {
    const normalized = normalizeElicitationSchema(schema);
    if (!normalized.ok) throw new Error(normalized.reason);
    const fields = normalized.value;
    const accepted = validateElicitationContent(fields, {
      name: "Ada",
      plan: "pro",
      tags: ["x"],
    });
    expect(accepted).toEqual({ ok: true, value: { name: "Ada", plan: "pro", tags: ["x"] } });
    expect(Object.keys(accepted.ok ? accepted.value : {})).not.toContain("subscribe");

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ plan: "pro" }, '"Name" is required'],
      [{ name: "A", plan: "pro" }, "at least 2"],
      [{ name: "Ada", plan: "team" }, "listed choices"],
      [{ name: "Ada", plan: "pro", email: "nope" }, "valid email"],
      [{ name: "Ada", plan: "pro", age: 1.5 }, "whole number"],
      [{ name: "Ada", plan: "pro", tags: ["x", "x"] }, "repeats"],
      [{ name: "Ada", plan: "pro", tags: ["x", "y", "z"] }, "at most 2"],
      [{ name: "Ada", plan: "pro", extra: 1 }, "does not ask for"],
      [{ name: "Ada", plan: "pro", subscribe: "yes" }, "yes or no"],
    ];
    for (const [content, reason] of cases) {
      const result = validateElicitationContent(fields, content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(reason);
        // Reasons name fields, never the submitted values.
        expect(result.reason).not.toContain("nope");
      }
    }
  });

  it("rejects oversized answers", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: { note: { type: "string" } },
    });
    if (!fields.ok) throw new Error(fields.reason);
    const result = validateElicitationContent(fields.value, { note: "x".repeat(70_000) });
    expect(result).toEqual({ ok: false, reason: "The answer is too large." });
  });

  it("only accepts http(s) URL requests without embedded credentials", () => {
    expect(
      buildElicitationDescriptor({
        mode: "url",
        message: "Sign in",
        url: "https://example.com/auth?x=1",
        nativeId: "el-1",
        serverName: "srv",
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: "url",
        message: "Sign in",
        url: "https://example.com/auth?x=1",
        nativeId: "el-1",
        serverName: "srv",
      },
    });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.com"])
      expect(buildElicitationDescriptor({ mode: "url", message: "", url }).ok).toBe(false);
  });

  it("accepts an empty confirmation form", () => {
    const result = buildElicitationDescriptor({
      mode: "form",
      message: "Continue?",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result.ok && result.value.fields).toEqual([]);
  });
});
