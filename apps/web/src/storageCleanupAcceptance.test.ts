import type {
  StorageCleanupRequest,
  StorageCleanupStatus,
  StorageStatus,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acceptStorageCleanup } from "./storageCleanupAcceptance";
import {
  noteWsConnectionOpened,
  noteWsSynchronized,
  noteWsConnectionClosed,
  resetWsConnectionStateForTests,
} from "./wsConnectionState";

const request: StorageCleanupRequest = {
  operationId: "operation",
  backendEpoch: "epoch",
  scanId: "scan",
  nonce: "nonce",
  categoryIds: ["orphanAttachments"],
};
const operation: StorageCleanupStatus = {
  operationId: "operation",
  state: "running",
  startedAt: "2026-10-19T08:00:00.000Z",
  completedAt: null,
  progress: null,
  result: null,
  error: null,
  omittedCount: 0,
};
function fixture() {
  const status: StorageStatus = {
    backendEpoch: "epoch",
    revision: 1,
    updatedAt: operation.startedAt,
    scan: { state: "idle", phase: null, entriesVisited: 0, startedAt: null, error: null },
    cleanup: operation,
  };
  return {
    cleanup: vi
      .fn(async (_request: StorageCleanupRequest) => operation)
      .mockRejectedValueOnce(new Error("WebSocket connection closed.")),
    getStatus: vi.fn(async () => status),
    getOperation: vi.fn(async () => ({ status: operation, results: [], nextCursor: null })),
  };
}
beforeEach(() => {
  noteWsConnectionOpened();
  noteWsSynchronized();
});
afterEach(() => {
  resetWsConnectionStateForTests();
});
test("finds an accepted operation after losing its acknowledgement without executing it again", async () => {
  const api = fixture();
  expect(await acceptStorageCleanup(api, request)).toEqual(operation);
  expect(api.cleanup).toHaveBeenCalledTimes(1);
  expect(api.getOperation).toHaveBeenCalledWith({ operationId: request.operationId });
});
test("resubmits exactly the same request once when acceptance did not reach the backend", async () => {
  const api = fixture();
  api.getOperation.mockRejectedValueOnce(new Error("operation_unknown"));
  expect(await acceptStorageCleanup(api, request)).toEqual(operation);
  expect(api.cleanup).toHaveBeenCalledTimes(2);
  expect(api.cleanup.mock.calls[1]?.[0]).toBe(request);
});
test("never resubmits across a backend restart", async () => {
  const api = fixture();
  api.getStatus.mockResolvedValueOnce({ ...(await api.getStatus()), backendEpoch: "restarted" });
  await expect(acceptStorageCleanup(api, request)).rejects.toThrow("Rescan and confirm");
  expect(api.cleanup).toHaveBeenCalledTimes(1);
  expect(api.getOperation).not.toHaveBeenCalled();
});
test("does not retry an explicit cleanup validation failure", async () => {
  const api = fixture();
  api.cleanup.mockReset().mockRejectedValue(new Error("Storage changed since this report"));
  await expect(acceptStorageCleanup(api, request)).rejects.toThrow("Storage changed");
  expect(api.cleanup).toHaveBeenCalledTimes(1);
  expect(api.getStatus).not.toHaveBeenCalled();
});
test("waits for synchronization before checking acceptance", async () => {
  const api = fixture();
  noteWsConnectionClosed();
  const pending = acceptStorageCleanup(api, request);
  await Promise.resolve();
  expect(api.getStatus).not.toHaveBeenCalled();
  noteWsConnectionOpened();
  expect(api.getStatus).not.toHaveBeenCalled();
  noteWsSynchronized();
  expect(await pending).toEqual(operation);
  expect(api.cleanup).toHaveBeenCalledTimes(1);
});
