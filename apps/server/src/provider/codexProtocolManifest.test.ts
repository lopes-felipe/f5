import { describe, expect, it } from "vitest";

import {
  diffCodexProtocolSurface,
  extractCodexTaggedUnionValues,
} from "@t3tools/shared/codexProtocolAudit";
import {
  CODEX_NOTIFICATION_DISPOSITIONS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_DISPOSITIONS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_DISPOSITIONS,
  CODEX_THREAD_ITEM_TYPES,
  codexNotificationDisposition,
  codexServerRequestDisposition,
  codexThreadItemDisposition,
} from "@t3tools/shared/codexProtocolManifest";

describe("Codex 0.144 protocol manifest", () => {
  it("classifies every notification, request, and thread item exactly once", () => {
    expect(CODEX_NOTIFICATION_METHODS).toHaveLength(69);
    expect(CODEX_SERVER_REQUEST_METHODS).toHaveLength(11);
    expect(CODEX_THREAD_ITEM_TYPES).toHaveLength(18);
    expect(Object.keys(CODEX_NOTIFICATION_DISPOSITIONS)).toHaveLength(69);
    expect(Object.keys(CODEX_SERVER_REQUEST_DISPOSITIONS)).toHaveLength(11);
    expect(Object.keys(CODEX_THREAD_ITEM_DISPOSITIONS)).toHaveLength(18);

    for (const method of CODEX_NOTIFICATION_METHODS) {
      expect(codexNotificationDisposition(method)).toBeDefined();
    }
    for (const method of CODEX_SERVER_REQUEST_METHODS) {
      expect(codexServerRequestDisposition(method)).toBeDefined();
    }
    for (const itemType of CODEX_THREAD_ITEM_TYPES) {
      expect(codexThreadItemDisposition(itemType)).toBeDefined();
    }
  });

  it("extracts generated tagged unions without accepting unrelated string literals", () => {
    expect(
      extractCodexTaggedUnionValues(
        'type ServerNotification = { "method": "hook/started", params: X } | { "method": "hook/completed", params: Y };',
        "method",
      ),
    ).toEqual(["hook/completed", "hook/started"]);
    expect(
      extractCodexTaggedUnionValues(
        'type ThreadItem = { "type": "sleep", id: string } | { "type": "imageGeneration", status: string };',
        "type",
      ),
    ).toEqual(["imageGeneration", "sleep"]);
  });

  it("reports added and removed surface drift", () => {
    const report = diffCodexProtocolSurface({
      notifications: [...CODEX_NOTIFICATION_METHODS.filter((value) => value !== "warning"), "new"],
      requests: CODEX_SERVER_REQUEST_METHODS,
      items: CODEX_THREAD_ITEM_TYPES,
    });
    expect(report.hasDrift).toBe(true);
    expect(report.notifications).toEqual({ added: ["new"], removed: ["warning"] });
    expect(report.requests).toEqual({ added: [], removed: [] });
    expect(report.items).toEqual({ added: [], removed: [] });
  });
});
