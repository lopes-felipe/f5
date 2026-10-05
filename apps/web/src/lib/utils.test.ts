import { assert, describe, it } from "vitest";

import { cn, isWindowsPlatform } from "./utils";

describe("cn", () => {
  it("keeps custom font sizes alongside text colours", () => {
    assert.strictEqual(cn("text-ui", "text-muted-foreground"), "text-ui text-muted-foreground");
    assert.strictEqual(cn("text-2xs", "text-foreground"), "text-2xs text-foreground");
  });

  it("treats custom font sizes as conflicting with the built-in scale", () => {
    assert.strictEqual(cn("text-xs", "text-2xs"), "text-2xs");
    assert.strictEqual(cn("text-sm", "text-ui"), "text-ui");
    assert.strictEqual(cn("text-ui", "text-sm"), "text-sm");
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});
