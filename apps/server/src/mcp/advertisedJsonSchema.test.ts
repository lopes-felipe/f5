import { expect, it } from "vitest";
import { advertisedJsonSchema } from "./advertisedJsonSchema";

it("compacts optional metadata while preserving closed objects and real numeric bounds", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["count"],
    properties: {
      count: { type: "integer", minimum: 1, maximum: 50 },
      cursor: { anyOf: [{ type: "null" }, { type: "integer", maximum: Number.MAX_SAFE_INTEGER }] },
    },
  };
  expect(advertisedJsonSchema(schema)).toEqual({
    ...schema,
    properties: { count: schema.properties.count, cursor: { type: "integer" } },
  });
  expect(schema.properties.cursor.anyOf).toHaveLength(2);
});
it("merges tagged shapes without advertising branch-only fields as required", () => {
  expect(
    advertisedJsonSchema({
      anyOf: [
        {
          type: "object",
          properties: { action: { const: "read" }, id: { type: "string" } },
          required: ["action", "id"],
        },
        { type: "object", properties: { action: { const: "list" } }, required: ["action"] },
      ],
    }),
  ).toEqual({
    type: "object",
    properties: { action: { type: "string", enum: ["read", "list"] }, id: { type: "string" } },
    required: ["action"],
  });
});
