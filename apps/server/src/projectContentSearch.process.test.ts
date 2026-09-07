import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";

import { makeProjectContentSearchManager } from "./projectContentSearch";

vi.mock("./projectContentSearchWorker", () => ({
  PROJECT_CONTENT_SEARCH_WORKER_SOURCE: `
    const fs = require("node:fs");
    const path = require("node:path");
    let root;
    process.on("message", (message) => {
      if (message.type === "initialize") {
        root = message.rootPath;
        process.send({ id: message.id, type: "result", value: {
          indexedPathCount: 1, indexTruncated: false
        } });
      } else if (message.type === "search") {
        fs.writeFileSync(path.join(root, "pid"), String(process.pid));
        // Simulate a native call that never returns to the JavaScript event loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
  `,
}));

it.each(["cancel", "dispose"] as const)(
  "%s stops a search process even while synchronous work is blocked",
  async (operation) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f5-search-process-"));
    const manager = makeProjectContentSearchManager();
    try {
      const pending = manager.search({
        requestKey: "client:blocked",
        workspaceRoot,
        request: {
          requestId: "blocked",
          projectId: ProjectId.makeUnsafe("project-search-process"),
          query: "needle",
          limit: 500,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({ failure: "cancelled" });
      const pidPath = path.join(workspaceRoot, "pid");
      await expect.poll(() => fs.existsSync(pidPath)).toBe(true);
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      expect(pid).not.toBe(process.pid);

      if (operation === "cancel") {
        await expect(manager.cancel("client:blocked")).resolves.toBe(true);
      } else {
        await manager.dispose();
      }
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await manager.dispose();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);
