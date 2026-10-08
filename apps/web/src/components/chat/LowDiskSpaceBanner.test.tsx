import type { DiskSpaceStatus } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { newerDiskSpaceStatus } from "../../hooks/useDiskSpaceStatus";
import { LowDiskSpaceBanner } from "./LowDiskSpaceBanner";

const GB = 1024 ** 3;

function status(overrides: Partial<DiskSpaceStatus>): DiskSpaceStatus {
  return {
    level: "ok",
    checkedAt: "2026-10-08T00:00:00.000Z",
    lowThresholdBytes: 10 * GB,
    criticalThresholdBytes: 2 * GB,
    volumes: [],
    reclaimable: [],
    ...overrides,
  };
}

const render = (value: DiskSpaceStatus | null) =>
  renderToStaticMarkup(<LowDiskSpaceBanner status={value} onOpenStorage={() => undefined} />);

describe("LowDiskSpaceBanner", () => {
  it("renders nothing while space is ok or unknown", () => {
    expect(render(null)).toBe("");
    expect(render(status({}))).toBe("");
  });

  it("warns below the low threshold and lists the biggest reclaimable items", () => {
    const markup = render(
      status({
        level: "low",
        volumes: [
          { path: "/data", roles: ["userdata"], freeBytes: 50 * GB, totalBytes: 0, level: "ok" },
          {
            path: "/Users/me/.codex",
            roles: ["claudeHome", "codexHome"],
            freeBytes: 6 * GB,
            totalBytes: 500 * GB,
            level: "low",
          },
        ],
        reclaimable: [
          { categoryId: "codexMarketplaceStaging", title: "Codex staging", bytes: 42 * GB },
          { categoryId: "purgeDeletedThreads", title: "Purge deleted threads", bytes: 4 * GB },
          { categoryId: "providerLogRotations", title: "Log rotations", bytes: GB },
          { categoryId: "orphanAttachments", title: "Orphan attachments", bytes: 1 },
        ],
      }),
    );
    expect(markup).toContain("Low disk space");
    expect(markup).toContain("6 GB free on the volume holding Claude home, Codex home");
    expect(markup).toContain("/Users/me/.codex");
    expect(markup).toContain("Codex staging (42 GB)");
    expect(markup).toContain("Log rotations (1 GB)");
    expect(markup).not.toContain("Orphan attachments");
    expect(markup).toContain("Free up space");
  });

  it("says new turns are held below the critical threshold", () => {
    const markup = render(
      status({
        level: "critical",
        volumes: [
          { path: "/data", roles: ["userdata"], freeBytes: GB, totalBytes: 0, level: "critical" },
        ],
      }),
    );
    expect(markup).toContain("new turns are held");
    expect(markup).toContain("Turns start again once more than 2 GB is free.");
  });
});

describe("newerDiskSpaceStatus", () => {
  it("keeps the most recently checked status", () => {
    const older = status({ checkedAt: "2026-10-08T00:00:00.000Z", level: "low" });
    const newer = status({ checkedAt: "2026-10-08T00:01:00.000Z" });
    expect(newerDiskSpaceStatus(undefined, older)).toBe(older);
    expect(newerDiskSpaceStatus(newer, older)).toBe(newer);
    expect(newerDiskSpaceStatus(older, newer)).toBe(newer);
  });
});
