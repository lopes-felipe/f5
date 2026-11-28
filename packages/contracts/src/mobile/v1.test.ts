import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/v1/wire.json";
import surface from "./fixtures/v1/surface.json";
import {
  MobileBatch,
  MobileBootstrap,
  MobilePairRequest,
  MobilePairResponse,
  MobileStatus,
  mobileMethods,
  mobileResults,
} from "./v1";

// Keep the frozen schema constraining existing properties and required keys.
// New optional properties and methods can coexist with the v1 surface.
function expectCompatible(before: unknown, after: unknown) {
  if (before === null || typeof before !== "object" || Array.isArray(before)) {
    expect(after).toEqual(before);
    return;
  }
  expect(after).toBeTypeOf("object");
  const existing = before as Record<string, unknown>;
  const current = after as Record<string, unknown>;
  expect(Object.keys(current).toSorted()).toEqual(Object.keys(existing).toSorted());
  for (const [key, shape] of Object.entries(existing)) {
    if (key === "properties") {
      const fields = current[key] as Record<string, unknown>;
      for (const [name, field] of Object.entries(shape as Record<string, unknown>)) {
        expect(Object.hasOwn(fields, name)).toBe(true);
        expectCompatible(field, fields[name]);
      }
    } else expectCompatible(shape, current[key]);
  }
}

describe("mobile API v1 fixtures", () => {
  it("preserves the frozen JSON Schema surface while permitting optional additions", () => {
    const schemas: Readonly<Record<string, Schema.Top>> = {
      status: MobileStatus,
      pairRequest: MobilePairRequest,
      pairResponse: MobilePairResponse,
      bootstrap: MobileBootstrap,
      batch: MobileBatch,
      ...Object.fromEntries(
        Object.entries(mobileMethods).map(([name, schema]) => ["request." + name, schema]),
      ),
      ...Object.fromEntries(
        Object.entries(mobileResults).map(([name, schema]) => ["result." + name, schema]),
      ),
    };
    for (const [name, snapshot] of Object.entries(surface)) {
      const schema = schemas[name];
      expect(schema, name).toBeDefined();
      expectCompatible(snapshot, Schema.toJsonSchemaDocument(schema!));
    }
  });
  it("retains each beta request method and decodes its response", () => {
    for (const [name, { request, response }] of Object.entries(fixtures.methods)) {
      const method = name as keyof typeof mobileMethods;
      expect(
        Schema.decodeUnknownSync(mobileMethods[method])(request, { onExcessProperty: "error" }),
      ).toEqual(request);
      const future = { ...response, futureField: "ignored by v1" };
      expect(Schema.decodeUnknownSync(mobileResults[method])(future)).toEqual(response);
    }
  });

  it("retains the pairing, bootstrap and live envelope shapes", () => {
    expect(Schema.is(MobilePairRequest)(fixtures.pair.request)).toBe(true);
    expect(Schema.is(MobilePairResponse)(fixtures.pair.response)).toBe(true);
    expect(Schema.is(MobileStatus)(fixtures.status)).toBe(true);
    expect(Schema.is(MobileBootstrap)(fixtures.bootstrap)).toBe(true);
    for (const frame of fixtures.pushes) {
      if (frame.channel === "mobile.batch") expect(Schema.is(MobileBatch)(frame.body)).toBe(true);
      if (frame.channel === "mobile.welcome")
        expect(Schema.is(MobileBootstrap)(frame.body)).toBe(true);
    }
  });
});
