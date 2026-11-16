import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { diffMuseProtocolSurface, extractMuseProtocolSurface } from "./museProtocolAudit.ts";

const require = createRequire(import.meta.url);
const declarations = readFileSync(
  path.join(path.dirname(require.resolve("@muse-code/sdk")), "msp.d.ts"),
  "utf8",
);

describe("muse protocol audit", () => {
  it("classifies every notification in the pinned SDK", () => {
    const drift = diffMuseProtocolSurface(extractMuseProtocolSurface(declarations));
    expect(drift).toEqual({
      unclassifiedNotifications: [],
      removedNotifications: [],
      unclassifiedServerRequests: [],
      missingMethods: [],
    });
  });

  it("reports a new notification as unclassified", () => {
    const surface = extractMuseProtocolSurface(declarations);
    const drift = diffMuseProtocolSurface({
      ...surface,
      notifications: [...surface.notifications, "session/brandNew"],
    });
    expect(drift.unclassifiedNotifications).toEqual(["session/brandNew"]);
  });
});
