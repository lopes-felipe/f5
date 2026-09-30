import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadId, F5_PROTOCOL_VERSION } from "@t3tools/contracts";
import { uploadAttachment } from "./attachmentUploadQueue";
import { getProtocolState, resetProtocolStateForTests, setServerBootstrap } from "../protocolState";
import { serverBootstrapFixture } from "../test/serverBootstrap";
class FakeRequest {
  static instances: FakeRequest[] = [];
  headers: Record<string, string> = {};
  upload: { onprogress?: (event: { loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  status = 201;
  responseText = "";
  url = "";
  constructor() {
    FakeRequest.instances.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return "0";
  }
  send() {}
  abort() {
    this.onabort?.();
  }
  complete() {
    this.responseText = JSON.stringify({
      uploadId: crypto.randomUUID(),
      draftThreadId: "draft",
      kind: "file",
      name: "test.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      contentHash: "hash",
      expiresAt: "2099-01-01",
    });
    this.onload?.();
  }
}
beforeEach(() => {
  resetProtocolStateForTests();
  setServerBootstrap(serverBootstrapFixture);
  FakeRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const threadId = ThreadId.makeUnsafe("draft");
it("runs two transfers, tracks queued work, reports progress and sends version/name headers", async () => {
  const progress = vi.fn();
  const file = new File(["x"], "世界.pdf", { type: "application/pdf" });
  const jobs = [0, 1, 2].map(() =>
    uploadAttachment("http://localhost", threadId, file, { onProgress: progress }),
  );
  expect(FakeRequest.instances).toHaveLength(2);
  expect(getProtocolState().activeUploads).toBe(3);
  const first = FakeRequest.instances[0]!;
  expect(first.headers["X-F5-File-Name"]).toBe(encodeURIComponent("世界.pdf"));
  expect(first.headers["X-F5-Protocol"]).toBe(String(F5_PROTOCOL_VERSION));
  first.upload.onprogress?.({ loaded: 1, total: 1 });
  expect(progress).toHaveBeenCalledWith(1, 1);
  first.complete();
  await jobs[0];
  await vi.waitFor(() => expect(FakeRequest.instances).toHaveLength(3));
  FakeRequest.instances[1]!.complete();
  FakeRequest.instances[2]!.complete();
  await Promise.all(jobs);
  expect(getProtocolState().activeUploads).toBe(0);
});
it("cancels queued files immediately without issuing another request", async () => {
  const file = new File(["x"], "test.pdf");
  const first = uploadAttachment("", threadId, file);
  const second = uploadAttachment("", threadId, file);
  const controller = new AbortController();
  const queued = uploadAttachment("", threadId, file, { signal: controller.signal });
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(FakeRequest.instances).toHaveLength(2);
  expect(getProtocolState().activeUploads).toBe(2);
  FakeRequest.instances.forEach((request) => request.complete());
  await Promise.all([first, second]);
});
it("backs off on 429 and aborts a stalled upload without forcing reload", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const job = uploadAttachment("", threadId, new File(["x"], "test.pdf"), {
    signal: controller.signal,
  });
  const rejected = expect(job).rejects.toMatchObject({ name: "AbortError" });
  FakeRequest.instances[0]!.status = 429;
  FakeRequest.instances[0]!.onload?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeRequest.instances).toHaveLength(2);
  controller.abort();
  await rejected;
  expect(getProtocolState().activeUploads).toBe(0);
});
