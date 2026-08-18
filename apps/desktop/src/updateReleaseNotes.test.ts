import { describe, expect, it } from "vitest";

import { normalizeDesktopUpdateReleaseNotes } from "./updateReleaseNotes";

describe("normalizeDesktopUpdateReleaseNotes", () => {
  it("normalizes HTML notes to plain text", () => {
    expect(
      normalizeDesktopUpdateReleaseNotes(
        "<h2>What's changed</h2><ul><li>Fix &amp; polish</li><li>Safer updates</li></ul>",
      ),
    ).toBe("What's changed\n• Fix & polish\n• Safer updates");
  });

  it("accepts versioned note arrays and ignores malformed entries", () => {
    expect(
      normalizeDesktopUpdateReleaseNotes([
        { version: "1.2.0", note: "First" },
        { version: 12, note: "Second" },
        { version: "1.1.0", note: null },
      ]),
    ).toBe("1.2.0\nFirst\nSecond");
  });

  it("removes active markup and bounds the result", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      `<script>alert('no')</script><style>body{display:none}</style>${"x".repeat(2_000)}`,
    );
    expect(result).not.toContain("alert");
    expect(result).not.toContain("display:none");
    expect(result?.length).toBe(1_200);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("returns null for empty or malformed payloads", () => {
    expect(normalizeDesktopUpdateReleaseNotes(null)).toBeNull();
    expect(normalizeDesktopUpdateReleaseNotes({ note: 42 })).toBeNull();
    expect(normalizeDesktopUpdateReleaseNotes("<div> </div>")).toBeNull();
  });

  it("bounds array item reads before joining remote release-note payloads", () => {
    let noteReads = 0;
    const entries = Array.from({ length: 1_000 }, (_, index) => ({
      version: `v${index}`,
      get note() {
        noteReads += 1;
        return "x".repeat(4_000);
      },
    }));

    const result = normalizeDesktopUpdateReleaseNotes(entries);

    expect(result?.length).toBe(1_200);
    expect(noteReads).toBeLessThanOrEqual(64);
  });
});
