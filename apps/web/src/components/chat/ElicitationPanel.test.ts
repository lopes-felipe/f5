import type { ElicitationField } from "@t3tools/contracts";
import { validateElicitationContent } from "@t3tools/shared/elicitationForm";
import { describe, expect, it } from "vitest";
import { elicitationContentFromDraft } from "./ElicitationPanel";

const fields: ElicitationField[] = [
  { key: "name", title: "Name", required: true, type: "string" },
  { key: "age", title: "Age", required: false, type: "integer" },
  { key: "ok", title: "OK", required: false, type: "boolean" },
  {
    key: "tags",
    title: "Tags",
    required: false,
    type: "multiselect",
    options: [{ value: "a", label: "A" }],
  },
];

describe("elicitationContentFromDraft", () => {
  it("types visible values and omits empty ones", () => {
    expect(
      elicitationContentFromDraft(fields, { name: "Ada", age: "36", ok: false, tags: [] }),
    ).toEqual({ name: "Ada", age: 36, ok: false, tags: [] });
    expect(elicitationContentFromDraft(fields, { name: "", age: "" })).toEqual({});
  });

  it("submits an explicit empty choice for a required list that allows none", () => {
    const required: ElicitationField[] = [{ ...fields[3]!, required: true, minItems: 0 }];
    // "None" sets [], which is sent; an untouched field stays omitted.
    expect(
      validateElicitationContent(required, elicitationContentFromDraft(required, { tags: [] })),
    ).toEqual({ ok: true, value: { tags: [] } });
    expect(validateElicitationContent(required, elicitationContentFromDraft(required, {})).ok).toBe(
      false,
    );
  });

  it("keeps unparseable numbers so validation names the field", () => {
    const content = elicitationContentFromDraft(fields, { name: "Ada", age: "thirty" });
    const result = validateElicitationContent(fields, content);
    expect(result).toEqual({ ok: false, reason: '"Age" must be a number.' });
  });
});
