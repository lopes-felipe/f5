import { describe, expect, it } from "vitest";

import { resolveSettingsSearchShortcut } from "./settingsSearchShortcut";

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...modifiers,
});

describe("resolveSettingsSearchShortcut", () => {
  it("treats Cmd+F and Ctrl+F as find", () => {
    expect(resolveSettingsSearchShortcut(key("f", { metaKey: true }))).toBe("find");
    expect(resolveSettingsSearchShortcut(key("F", { ctrlKey: true }))).toBe("find");
  });

  it("keeps plain slash as the in-page shortcut", () => {
    expect(resolveSettingsSearchShortcut(key("/"))).toBe("slash");
    expect(resolveSettingsSearchShortcut(key("/", { metaKey: true }))).toBeNull();
  });

  it("ignores other chords, composition, and handled events", () => {
    expect(resolveSettingsSearchShortcut(key("f"))).toBeNull();
    expect(resolveSettingsSearchShortcut(key("f", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(resolveSettingsSearchShortcut(key("f", { metaKey: true, altKey: true }))).toBeNull();
    expect(
      resolveSettingsSearchShortcut(key("f", { metaKey: true, isComposing: true })),
    ).toBeNull();
    expect(
      resolveSettingsSearchShortcut(key("f", { metaKey: true, defaultPrevented: true })),
    ).toBeNull();
  });
});
