import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeProjectContentSearchManager,
  PROJECT_CONTENT_SEARCH_ACTIVE_INDEX_LIMIT,
  PROJECT_CONTENT_SEARCH_IDLE_EVICTION_MS,
} from "./projectContentSearch";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-content-search-"));
  tempDirs.push(directory);
  return directory;
}

function request(requestId: string, query = "needle") {
  return {
    requestId,
    projectId: ProjectId.makeUnsafe("project-content-search"),
    query,
    limit: 500,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  } as const;
}

function fakeWorkerFactory(input?: {
  readonly onCall?: (message: Record<string, unknown>) => unknown | Promise<unknown>;
  readonly onTerminate?: () => void;
}) {
  let terminated = false;
  return {
    isTerminated: () => terminated,
    call: async <T>(message: Record<string, unknown>): Promise<T> => {
      if (terminated) throw new Error("terminated");
      const overridden = await input?.onCall?.(message);
      if (overridden !== undefined) return overridden as T;
      if (message.type === "search") {
        return {
          matches: [],
          truncated: false,
          indexedPathCount: 1,
          indexTruncated: false,
        } as T;
      }
      return { indexedPathCount: 1, indexTruncated: false } as T;
    },
    terminate: async () => {
      terminated = true;
      input?.onTerminate?.();
    },
  };
}

describe("project content search", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("searches in the native worker and returns Unicode code-point ranges", async () => {
    const workspaceRoot = makeTempDir();
    fs.writeFileSync(
      path.join(workspaceRoot, "unicode.txt"),
      "prefix 😀 café needle suffix\n",
      "utf8",
    );
    const manager = makeProjectContentSearchManager();
    try {
      const result = await manager.search({
        requestKey: "client:unicode",
        workspaceRoot,
        request: request("unicode", "café"),
      });
      expect(result.requestId).toBe("unicode");
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        path: "unicode.txt",
        lineNumber: 1,
        matchRanges: [{ start: 9, end: 13 }],
      });
    } finally {
      await manager.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not index content through a symlink escape",
    async () => {
      const workspaceRoot = makeTempDir();
      const outsideRoot = makeTempDir();
      fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "outside-only-secret\n", "utf8");
      fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "escaped"), "dir");
      const manager = makeProjectContentSearchManager();
      try {
        const result = await manager.search({
          requestKey: "client:symlink",
          workspaceRoot,
          request: request("symlink", "outside-only-secret"),
        });
        expect(result.matches).toEqual([]);
      } finally {
        await manager.dispose();
      }
    },
  );

  it("terminates native work when a request is cancelled", async () => {
    const workspaceRoot = makeTempDir();
    let startSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => {
      startSearch = resolve;
    });
    let terminateCount = 0;
    const manager = makeProjectContentSearchManager({
      workerFactory: () =>
        fakeWorkerFactory({
          onCall: (message) => {
            if (message.type !== "search") return undefined;
            startSearch?.();
            return new Promise(() => undefined);
          },
          onTerminate: () => {
            terminateCount += 1;
          },
        }),
    });
    const pending = manager.search({
      requestKey: "client:cancel",
      workspaceRoot,
      request: request("cancel"),
    });
    await searchStarted;
    await expect(manager.cancel("client:cancel")).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({
      failure: "cancelled",
    });
    expect(terminateCount).toBe(1);
    await manager.dispose();
  });

  it("refreshes an invalidated index before the next search", async () => {
    const workspaceRoot = makeTempDir();
    const calls: string[] = [];
    const manager = makeProjectContentSearchManager({
      workerFactory: () =>
        fakeWorkerFactory({
          onCall: (message) => {
            calls.push(String(message.type));
            return undefined;
          },
        }),
    });
    try {
      await manager.search({
        requestKey: "client:first",
        workspaceRoot,
        request: request("first"),
      });
      manager.invalidateWorkspaceRoot(workspaceRoot);
      await manager.search({
        requestKey: "client:second",
        workspaceRoot,
        request: request("second"),
      });
      expect(calls).toEqual(["initialize", "search", "refresh", "search"]);
    } finally {
      await manager.dispose();
    }
  });

  it("keeps at most two active workspace indexes", async () => {
    const roots = Array.from({ length: PROJECT_CONTENT_SEARCH_ACTIVE_INDEX_LIMIT + 1 }, () =>
      makeTempDir(),
    );
    let createdWorkers = 0;
    let terminatedWorkers = 0;
    const manager = makeProjectContentSearchManager({
      workerFactory: () => {
        createdWorkers += 1;
        return fakeWorkerFactory({
          onTerminate: () => {
            terminatedWorkers += 1;
          },
        });
      },
    });
    try {
      for (const [index, workspaceRoot] of roots.entries()) {
        await manager.search({
          requestKey: `client:${index}`,
          workspaceRoot,
          request: request(`request-${index}`),
        });
      }
      expect(createdWorkers).toBe(3);
      expect(terminatedWorkers).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it("evicts idle indexes before allocating another workspace", async () => {
    const firstRoot = makeTempDir();
    const secondRoot = makeTempDir();
    let timestamp = 0;
    let terminatedWorkers = 0;
    const manager = makeProjectContentSearchManager({
      now: () => timestamp,
      workerFactory: () =>
        fakeWorkerFactory({
          onTerminate: () => {
            terminatedWorkers += 1;
          },
        }),
    });
    try {
      await manager.search({
        requestKey: "client:idle-first",
        workspaceRoot: firstRoot,
        request: request("idle-first"),
      });
      timestamp = PROJECT_CONTENT_SEARCH_IDLE_EVICTION_MS;
      await manager.search({
        requestKey: "client:idle-second",
        workspaceRoot: secondRoot,
        request: request("idle-second"),
      });

      expect(terminatedWorkers).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it("fails a cold scan once without retrying beyond its budget", async () => {
    const workspaceRoot = makeTempDir();
    let createdWorkers = 0;
    const manager = makeProjectContentSearchManager({
      workerFactory: () => {
        createdWorkers += 1;
        return fakeWorkerFactory({
          onCall: (message) => {
            if (message.type === "initialize") throw new Error("scan failed");
            return undefined;
          },
        });
      },
    });
    try {
      await expect(
        manager.search({
          requestKey: "client:scan-failure",
          workspaceRoot,
          request: request("scan-failure"),
        }),
      ).rejects.toMatchObject({ failure: "scan_failed" });
      expect(createdWorkers).toBe(1);
    } finally {
      await manager.dispose();
    }
  });
});
