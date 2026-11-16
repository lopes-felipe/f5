import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODE_HIGHLIGHT_WORKER_MAX_LANGUAGES,
  CODE_HIGHLIGHT_MAX_JOBS,
  CODE_HIGHLIGHT_MAX_BYTES,
  codeHighlightResourceInventory,
  type CodeHighlightWorkerRequest,
  highlightCodeInWorker,
  setCodeHighlightWorkerFactoryForTests,
} from "./codeHighlightWorkerClient";

vi.mock("@pierre/diffs", () => ({
  resolveLanguage: vi.fn(async (language: string) => {
    if (language === "klingon") throw new Error(`"${language}" not found`);
    return { name: language === "typescript-alias" ? "typescript" : language, data: [] };
  }),
  resolveTheme: vi.fn(async (theme: string) => ({ name: theme })),
}));

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly messages: CodeHighlightWorkerRequest[] = [];
  terminated = false;
  /** When false, jobs stay pending until `respond` is called. */
  autoRespond = true;

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: CodeHighlightWorkerRequest) {
    this.messages.push(message);
    if (message.type === "highlight" && this.autoRespond) {
      queueMicrotask(() => this.respond(message.id, `<pre>${message.language}</pre>`));
    }
  }

  respond(id: number, html: string) {
    this.dispatchEvent(new MessageEvent("message", { data: { type: "result", id, html } }));
  }

  respondError(id: number, message: string) {
    this.dispatchEvent(new MessageEvent("message", { data: { type: "error", id, message } }));
  }

  crash() {
    const event = new Event("error") as Event & { message: string };
    event.message = "worker crashed";
    this.dispatchEvent(event);
  }

  terminate() {
    this.terminated = true;
  }

  highlightRequests() {
    return this.messages.filter(
      (message): message is Extract<CodeHighlightWorkerRequest, { type: "highlight" }> =>
        message.type === "highlight",
    );
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  setCodeHighlightWorkerFactoryForTests(() => new FakeWorker() as unknown as Worker);
});

afterEach(() => {
  setCodeHighlightWorkerFactoryForTests(null);
  vi.unstubAllGlobals();
});

describe("highlightCodeInWorker", () => {
  it("bounds jobs and physical bytes through cancellation and worker failure", async () => {
    setCodeHighlightWorkerFactoryForTests(() => {
      const worker = new FakeWorker();
      worker.autoRespond = false;
      return worker as unknown as Worker;
    });
    const controllers = Array.from(
      { length: CODE_HIGHLIGHT_MAX_JOBS },
      () => new AbortController(),
    );
    const pending = controllers.map((controller) =>
      highlightCodeInWorker({
        code: "bytes",
        language: "ts",
        theme: "pierre-dark",
        signal: controller.signal,
      }),
    );
    const settled = Promise.allSettled(pending);
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.highlightRequests()).toHaveLength(CODE_HIGHLIGHT_MAX_JOBS),
    );
    controllers.forEach((controller) => controller.abort());
    await settled;
    expect(codeHighlightResourceInventory()).toEqual({
      jobs: CODE_HIGHLIGHT_MAX_JOBS,
      bytes: CODE_HIGHLIGHT_MAX_JOBS * 5,
    });
    await expect(
      highlightCodeInWorker({ code: "next", language: "ts", theme: "pierre-dark" }),
    ).rejects.toThrow("capacity");
    FakeWorker.instances[0]!.crash();
    expect(codeHighlightResourceInventory()).toEqual({ jobs: 0, bytes: 0 });
    await expect(
      highlightCodeInWorker({
        code: "x".repeat(CODE_HIGHLIGHT_MAX_BYTES + 1),
        language: "ts",
        theme: "pierre-dark",
      }),
    ).rejects.toThrow("capacity");
    expect(codeHighlightResourceInventory()).toEqual({ jobs: 0, bytes: 0 });
  });

  it("retires cancelled jobs whose worker never acknowledges them", async () => {
    vi.useFakeTimers();
    try {
      setCodeHighlightWorkerFactoryForTests(() => {
        const worker = new FakeWorker();
        worker.autoRespond = false;
        return worker as unknown as Worker;
      });
      const controller = new AbortController();
      const work = highlightCodeInWorker({
        code: "x",
        language: "ts",
        theme: "pierre-dark",
        signal: controller.signal,
      });
      const settled = Promise.allSettled([work]);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await settled;
      expect(codeHighlightResourceInventory().jobs).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(codeHighlightResourceInventory()).toEqual({ jobs: 0, bytes: 0 });
      expect(FakeWorker.instances[0]!.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends each grammar and theme to a worker once", async () => {
    const first = await highlightCodeInWorker({ code: "a", language: "ts", theme: "pierre-dark" });
    const second = await highlightCodeInWorker({ code: "b", language: "ts", theme: "pierre-dark" });

    expect([first, second]).toEqual(["<pre>ts</pre>", "<pre>ts</pre>"]);
    const [worker] = FakeWorker.instances;
    const [firstRequest, secondRequest] = worker!.highlightRequests();
    expect(firstRequest).toMatchObject({ resolvedLanguages: [{ name: "ts" }] });
    expect(firstRequest!.resolvedThemes).toHaveLength(1);
    expect(secondRequest).toMatchObject({ resolvedLanguages: [], resolvedThemes: [] });
  });

  it("highlights unsupported languages as plain text", async () => {
    await expect(
      highlightCodeInWorker({ code: "a", language: "klingon", theme: "pierre-dark" }),
    ).resolves.toBe("<pre>text</pre>");
    expect(FakeWorker.instances[0]!.highlightRequests()[0]).toMatchObject({
      language: "text",
      resolvedLanguages: [],
    });
  });

  it("cancels a pending job when its signal aborts", async () => {
    const controller = new AbortController();
    setCodeHighlightWorkerFactoryForTests(() => {
      const worker = new FakeWorker();
      worker.autoRespond = false;
      return worker as unknown as Worker;
    });
    const pending = highlightCodeInWorker({
      code: "a",
      language: "ts",
      theme: "pierre-dark",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.highlightRequests()).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    const { id } = worker.highlightRequests()[0]!;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages.at(-1)).toEqual({ type: "cancel", id });
    // A late result for the cancelled job is ignored.
    worker.respond(id, "<pre>late</pre>");
  });

  it("rejects pending jobs when the worker fails and replaces it, then gives up", async () => {
    setCodeHighlightWorkerFactoryForTests(() => {
      const worker = new FakeWorker();
      worker.autoRespond = false;
      return worker as unknown as Worker;
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = highlightCodeInWorker({ code: "a", language: "ts", theme: "pierre-dark" });
      await vi.waitFor(() =>
        expect(FakeWorker.instances[attempt]?.highlightRequests()).toHaveLength(1),
      );
      FakeWorker.instances[attempt]!.crash();
      await expect(pending).rejects.toThrow("worker crashed");
      expect(FakeWorker.instances[attempt]!.terminated).toBe(true);
    }

    await expect(
      highlightCodeInWorker({ code: "a", language: "ts", theme: "pierre-dark" }),
    ).rejects.toThrow("disabled");
    expect(FakeWorker.instances).toHaveLength(3);
  });

  it("replaces an idle worker once it holds the maximum number of grammars", async () => {
    for (let index = 0; index < CODE_HIGHLIGHT_WORKER_MAX_LANGUAGES; index += 1) {
      await highlightCodeInWorker({ code: "a", language: `lang${index}`, theme: "pierre-dark" });
    }
    expect(FakeWorker.instances).toHaveLength(1);

    await highlightCodeInWorker({ code: "a", language: "one-more", theme: "pierre-dark" });

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    // The fresh worker receives the theme again along with the new grammar.
    expect(FakeWorker.instances[1]!.highlightRequests()[0]).toMatchObject({
      resolvedLanguages: [{ name: "one-more" }],
      resolvedThemes: [{ name: "pierre-dark" }],
    });
  });

  it("keeps a full worker for an alias of a grammar it already holds", async () => {
    for (let index = 0; index < CODE_HIGHLIGHT_WORKER_MAX_LANGUAGES - 1; index += 1) {
      await highlightCodeInWorker({ code: "a", language: `lang${index}`, theme: "pierre-dark" });
    }
    await highlightCodeInWorker({ code: "a", language: "typescript", theme: "pierre-dark" });

    await highlightCodeInWorker({ code: "a", language: "typescript-alias", theme: "pierre-dark" });

    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("sends a grammar again after the worker failed to load it", async () => {
    setCodeHighlightWorkerFactoryForTests(() => {
      const worker = new FakeWorker();
      worker.autoRespond = false;
      return worker as unknown as Worker;
    });
    const failed = highlightCodeInWorker({ code: "a", language: "ts", theme: "pierre-dark" });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.highlightRequests()).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    worker.respondError(worker.highlightRequests()[0]!.id, "grammar failed to load");
    await expect(failed).rejects.toThrow("grammar failed to load");

    // Left pending; the reset in afterEach rejects it.
    highlightCodeInWorker({ code: "b", language: "ts", theme: "pierre-dark" }).catch(() => {});
    await vi.waitFor(() => expect(worker.highlightRequests()).toHaveLength(2));
    expect(worker.highlightRequests()[1]).toMatchObject({
      resolvedLanguages: [{ name: "ts" }],
      resolvedThemes: [{ name: "pierre-dark" }],
    });
  });
});
