import { describe, expect, it } from "vitest";
import type { ComputerLeaseScope } from "@t3tools/contracts";
import {
  computerScopesConflict,
  computerBackgroundOpAllowed,
  computerBackgroundKeyAllowed,
} from "./computerExecution";
import { computerBackgroundEventAppAllowed } from "./computerApps";

describe("cooperative computer scopes", () => {
  const scopes: ComputerLeaseScope[] = [
    { kind: "foreground" },
    { kind: "app", appId: "a" },
    { kind: "app", appId: "b" },
    { kind: "takeover", appId: "a", approvalReceipt: "a" },
    { kind: "takeover", appId: "b", approvalReceipt: "b" },
  ];
  it("shares only app/app scopes, retaining every foreground and takeover exclusion", () => {
    for (const a of scopes)
      for (const b of scopes) {
        const sharing = computerScopesConflict(a, b, { shareApps: true });
        expect(sharing).toBe(
          a.kind === "app" && b.kind === "app" ? false : computerScopesConflict(a, b),
        );
        expect(sharing).toBe(computerScopesConflict(b, a, { shareApps: true }));
      }
  });
  it("requires negotiated and certified events for keys and scrolling, never pointer actions", () => {
    for (const op of ["key", "scroll"] as const) {
      expect(computerBackgroundOpAllowed(op)).toBe(false);
      expect(computerBackgroundOpAllowed(op, undefined, { events: true })).toBe(true);
    }
    for (const op of ["click", "move", "drag"] as const)
      expect(computerBackgroundOpAllowed(op, undefined, { events: true })).toBe(false);
    expect(computerBackgroundEventAppAllowed("unverified.example", "darwin")).toBe(false);
    expect(computerBackgroundEventAppAllowed("unverified.exe", "win32")).toBe(false);
  });
  it.each([
    "Meta+Tab",
    "Cmd+Space",
    "Control+ArrowUp",
    "Ctrl+Left",
    "Meta+Alt+Escape",
    "Control+Command+Q",
    "Meta+Shift+3",
    "Cmd+Shift+4",
    "Command+Shift+5",
  ])("keeps macOS desktop shortcut %s out of process-directed delivery", (chord) => {
    expect(computerBackgroundKeyAllowed([chord], "darwin")).toBe(false);
  });
  it.each(["Alt+Tab", "Win+E", "Meta+I", "Control+Alt+Delete", "Ctrl+Esc"])(
    "keeps Windows desktop shortcut %s out of window-directed delivery",
    (chord) => {
      expect(computerBackgroundKeyAllowed([chord], "win32")).toBe(false);
    },
  );
  it("allows app chords and rejects a mixed batch containing a desktop shortcut", () => {
    expect(computerBackgroundKeyAllowed(["Meta+A", "Down", "x"], "darwin")).toBe(true);
    expect(computerBackgroundKeyAllowed(["Control+A", "Down", "x"], "win32")).toBe(true);
    expect(computerBackgroundKeyAllowed(["Down", "Win+E"], "win32")).toBe(false);
  });
});
