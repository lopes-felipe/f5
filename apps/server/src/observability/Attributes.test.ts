import { assert, describe, it } from "@effect/vitest";

import {
  compactTraceAttributes,
  normalizeModelMetricLabel,
  truncateTraceAttributes,
} from "./Attributes.ts";

describe("Attributes", () => {
  it("bounds SQL and nested trace strings without changing the span", () => {
    const text = "x".repeat(2_000);
    const attributes = { "db.query.text": text, nested: { stack: text, values: [text, 1] } };
    const result = truncateTraceAttributes(compactTraceAttributes(attributes));
    assert.strictEqual(result["db.query.text"], "x".repeat(200) + "…[truncated]");
    assert.deepStrictEqual(result.nested, {
      stack: "x".repeat(500) + "…[truncated]",
      values: ["x".repeat(500) + "…[truncated]", 1],
    });
    assert.strictEqual(attributes.nested.stack, text);
  });
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate: new Date("not-a-real-date"),
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  it("groups supported model families under stable metric labels", () => {
    assert.strictEqual(normalizeModelMetricLabel("gpt-4o"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("claude-sonnet-4"), "claude");
    assert.strictEqual(normalizeModelMetricLabel("gemini-2.5-pro"), "gemini");
  });
});
