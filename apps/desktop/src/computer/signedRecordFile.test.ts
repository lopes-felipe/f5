import { describe, expect, it } from "vitest";
import { canonicalJson, SignedRecordFile } from "./signedRecordFile";

const KEY = Buffer.alloc(32, 7);
function memory() {
  let contents: string | undefined;
  return {
    read: () => contents,
    write: (value: string) => {
      contents = value;
    },
    remove: () => {
      contents = undefined;
    },
  };
}

describe("SignedRecordFile bounds", () => {
  const options = {
    payload: (profile: string, record: { value: number }) => canonicalJson([profile, record]),
    validate: (value: unknown): value is { value: number } =>
      !!value && typeof value === "object" && "value" in value && typeof value.value === "number",
    revokeFailureMessage: "revoke failed",
    maxProfiles: 2,
    maxRecordsPerProfile: 2,
  };

  it("bounds durable and run-only records, while allowing replacements", () => {
    for (const noKey of [false, true]) {
      const store = new SignedRecordFile(memory(), () => (noKey ? undefined : KEY), options);
      store.allow("p", "a", { value: 1 });
      store.allow("p", "b", { value: 2 });
      store.allow("p", "a", { value: 3 });
      expect(() => store.allow("p", "c", { value: 4 })).toThrow("limit");
      store.allow("q", "a", { value: 1 });
      expect(() => store.allow("r", "a", { value: 1 })).toThrow("limit");
    }
  });

  it("bounds loaded profiles and records too", () => {
    const io = memory();
    const store = new SignedRecordFile(io, () => KEY, {
      ...options,
      maxProfiles: 3,
      maxRecordsPerProfile: 3,
    });
    for (const profile of ["p", "q", "r"])
      for (const id of ["a", "b", "c"]) store.allow(profile, id, { value: 1 });
    const loaded = new SignedRecordFile(io, () => KEY, options);
    expect(loaded.profilesList()).toEqual(["p", "q"]);
    expect(loaded.list("p")).toHaveLength(2);
  });
});
