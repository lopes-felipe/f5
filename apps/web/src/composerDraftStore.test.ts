import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ComposerImageAttachment,
  createDebouncedStorage,
  mergePersistedRecords,
  pruneOrphanedDraftThreads,
  resetComposerDraftBaseStorageForTesting,
  setComposerDraftBaseStorageForTesting,
  useComposerDraftStore,
} from "./composerDraftStore";
import type { ComposerImageProcessor, CompressComposerImageResult } from "./lib/imageCompression";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

async function waitForComposerDraftVerification(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadId, first);
    useComposerDraftStore.getState().addImage(threadId, duplicateLater);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicateSameUrl]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore image imports", () => {
  const threadA = ThreadId.makeUnsafe("thread-import-a");
  const threadB = ThreadId.makeUnsafe("thread-import-b");
  let originalCreateObjectUrl: typeof URL.createObjectURL;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let nextObjectUrl = 0;

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      imageImportsByThreadId: {},
    });
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:import-${++nextObjectUrl}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    useComposerDraftStore.getState().clearThreadDraft(threadA);
    useComposerDraftStore.getState().clearThreadDraft(threadB);
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("reserves attachment slots before asynchronous processing", async () => {
    for (let index = 0; index < 7; index += 1) {
      useComposerDraftStore.getState().addImage(
        threadA,
        makeImage({
          id: `existing-${index}`,
          previewUrl: `blob:${index}`,
          name: `existing-${index}.png`,
        }),
      );
    }
    let resolveFirst!: (result: CompressComposerImageResult) => void;
    const firstProcessor: ComposerImageProcessor = () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      });
    const firstFile = new File([new Uint8Array(2)], "first.png", { type: "image/png" });
    const secondFile = new File([new Uint8Array(2)], "second.png", { type: "image/png" });

    const firstImport = useComposerDraftStore
      .getState()
      .importImages(threadA, [firstFile], { processor: firstProcessor });
    expect(useComposerDraftStore.getState().imageImportsByThreadId[threadA]?.pendingCount).toBe(1);

    const secondResult = await useComposerDraftStore
      .getState()
      .importImages(threadA, [secondFile], {
        processor: vi.fn<ComposerImageProcessor>(),
      });
    expect(secondResult.failures[0]?.message).toContain("up to 8 images");

    resolveFirst({
      ok: true,
      file: firstFile,
      recompressed: false,
      originalSizeBytes: firstFile.size,
      finalSizeBytes: firstFile.size,
    });
    await firstImport;
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.images).toHaveLength(8);
    expect(useComposerDraftStore.getState().imageImportsByThreadId[threadA]).toBeUndefined();
  });

  it("commits to the destination thread captured when the import starts", async () => {
    let resolveImport!: (result: CompressComposerImageResult) => void;
    const processor: ComposerImageProcessor = () =>
      new Promise((resolve) => {
        resolveImport = resolve;
      });
    const file = new File([new Uint8Array(3)], "bound.png", { type: "image/png" });
    const importPromise = useComposerDraftStore
      .getState()
      .importImages(threadA, [file], { processor });

    useComposerDraftStore.getState().setPrompt(threadB, "Viewing another thread");
    resolveImport({
      ok: true,
      file,
      recompressed: false,
      originalSizeBytes: file.size,
      finalSizeBytes: file.size,
    });
    await importPromise;

    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.images[0]?.name).toBe(
      "bound.png",
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadB]?.images).toEqual([]);
  });

  it("cancels pending work when its destination thread is deleted", async () => {
    const processor: ComposerImageProcessor = (_file, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => resolve({ ok: false, reason: "cancelled" }),
          { once: true },
        );
      });
    const file = new File([new Uint8Array(3)], "cancel.png", { type: "image/png" });
    const importPromise = useComposerDraftStore
      .getState()
      .importImages(threadA, [file], { processor });

    useComposerDraftStore.getState().clearThreadDraft(threadA);
    await expect(importPromise).resolves.toEqual({ imported: [], failures: [], cancelled: true });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]).toBeUndefined();
    expect(useComposerDraftStore.getState().imageImportsByThreadId[threadA]).toBeUndefined();
  });

  it("commits successful files atomically and releases failed reservations", async () => {
    const goodFile = new File([new Uint8Array(4)], "good.png", { type: "image/png" });
    const badFile = new File([new Uint8Array(4)], "animated.gif", { type: "image/gif" });
    const processor: ComposerImageProcessor = async (file) =>
      file === goodFile
        ? {
            ok: true,
            file,
            recompressed: false,
            originalSizeBytes: file.size,
            finalSizeBytes: file.size,
          }
        : { ok: false, reason: "animated" };

    const result = await useComposerDraftStore
      .getState()
      .importImages(threadA, [goodFile, badFile], { processor });

    expect(result.imported).toHaveLength(1);
    expect(result.failures[0]?.message).toContain("is animated");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.images).toHaveLength(1);
    expect(useComposerDraftStore.getState().imageImportsByThreadId[threadA]).toBeUndefined();
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);
    useComposerDraftStore.getState().addFilePaths(threadId, ["/repo/src/example.ts"]);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.makeUnsafe("thread-persisted-attachments");
  let baseStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    baseStorage = createMockStorage();
    setComposerDraftBaseStorageForTesting(baseStorage);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftBaseStorageForTesting();
  });

  it("confirms persisted image attachments after flushing the debounced draft write", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    const attachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,AAAA",
    };

    useComposerDraftStore.getState().addImage(threadId, image);
    useComposerDraftStore.getState().syncPersistedAttachments(threadId, [attachment]);

    await waitForComposerDraftVerification();

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      persistedAttachments: [attachment],
      nonPersistedImageIds: [],
    });
    expect(baseStorage.setItem).toHaveBeenCalled();
  });

  it("marks current images as non-persisted when the debounced storage flush fails", async () => {
    const image = makeImage({
      id: "img-persist-failure",
      previewUrl: "blob:persist-failure",
    });
    const attachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,BBBB",
    };

    useComposerDraftStore.getState().addImage(threadId, image);
    baseStorage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    useComposerDraftStore.getState().syncPersistedAttachments(threadId, [attachment]);

    await waitForComposerDraftVerification();

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      persistedAttachments: [],
      nonPersistedImageIds: [image.id],
    });
  });
});

describe("composerDraftStore prompt stash", () => {
  const projectId = ProjectId.makeUnsafe("project-stash");
  const sourceThreadId = ThreadId.makeUnsafe("thread-dedupe");
  const destinationThreadId = ThreadId.makeUnsafe("thread-stash-destination");
  let baseStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    baseStorage = createMockStorage();
    setComposerDraftBaseStorageForTesting(baseStorage);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      promptStashes: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftBaseStorageForTesting();
  });

  it("stores the complete draft and clears only sendable composer content", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(sourceThreadId, `Review ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`);
    store.addFilePaths(sourceThreadId, ["src/example.ts"]);
    store.addTerminalContext(sourceThreadId, makeTerminalContext({ id: "ctx-stash" }));
    store.addImage(
      sourceThreadId,
      makeImage({ id: "image-stash", previewUrl: "blob:image-stash" }),
    );
    store.setProvider(sourceThreadId, "codex");
    store.setProviderInstance(sourceThreadId, ProviderInstanceId.make("codex-work"));
    store.setModel(sourceThreadId, "gpt-5.1");
    store.setRuntimeMode(sourceThreadId, "auto");

    const result = await store.stashPromptDraft({
      threadId: sourceThreadId,
      projectId,
      workspaceRoot: "/repo",
    });

    expect(result.status).toBe("stored");
    expect(useComposerDraftStore.getState().promptStashes).toHaveLength(1);
    expect(useComposerDraftStore.getState().promptStashes[0]?.draft).toMatchObject({
      prompt: `Review ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      filePaths: ["src/example.ts"],
      provider: "codex",
      providerInstanceId: "codex-work",
      model: "gpt-5.1",
      runtimeMode: "auto",
      attachments: [{ id: "image-stash" }],
      terminalContexts: [{ id: "ctx-stash", text: "git status\nOn branch main" }],
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[sourceThreadId]).toMatchObject({
      prompt: "",
      filePaths: [],
      terminalContexts: [],
      provider: "codex",
      model: "gpt-5.1",
    });
    expect(baseStorage.setItem).toHaveBeenCalled();

    const stashId = useComposerDraftStore.getState().promptStashes[0]!.id;
    const restored = await useComposerDraftStore.getState().restorePromptStash({
      stashId,
      threadId: sourceThreadId,
      projectId,
      workspaceRoots: ["/repo"],
    });
    expect(restored).toMatchObject({ status: "restored" });
    expect(useComposerDraftStore.getState().draftsByThreadId[sourceThreadId]?.images).toHaveLength(
      1,
    );
  });

  it("requires confirmations before replacing content or dropping cross-thread terminals", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(sourceThreadId, INLINE_TERMINAL_CONTEXT_PLACEHOLDER);
    store.addTerminalContext(sourceThreadId, makeTerminalContext({ id: "ctx-cross-thread" }));
    store.addFilePaths(sourceThreadId, ["src/example.ts"]);
    const stored = await store.stashPromptDraft({
      threadId: sourceThreadId,
      projectId,
      workspaceRoot: "/repo",
    });
    expect(stored.status).toBe("stored");
    const stashId = useComposerDraftStore.getState().promptStashes[0]!.id;
    useComposerDraftStore.getState().setPrompt(destinationThreadId, "keep this first");

    expect(
      await useComposerDraftStore.getState().restorePromptStash({
        stashId,
        threadId: destinationThreadId,
        projectId,
        workspaceRoots: ["/other"],
      }),
    ).toMatchObject({ status: "needs-replace-confirmation" });
    expect(
      await useComposerDraftStore.getState().restorePromptStash({
        stashId,
        threadId: destinationThreadId,
        projectId,
        workspaceRoots: ["/other"],
        replaceNonEmpty: true,
      }),
    ).toMatchObject({ status: "needs-terminal-confirmation", invalidTerminalContextCount: 1 });

    const restored = await useComposerDraftStore.getState().restorePromptStash({
      stashId,
      threadId: destinationThreadId,
      projectId,
      workspaceRoots: ["/other"],
      replaceNonEmpty: true,
      dropInvalidTerminalContexts: true,
    });
    expect(restored).toMatchObject({ status: "restored" });
    expect(useComposerDraftStore.getState().draftsByThreadId[destinationThreadId]).toMatchObject({
      prompt: "",
      filePaths: ["src/example.ts"],
      terminalContexts: [],
    });
    expect(useComposerDraftStore.getState().promptStashes).toHaveLength(1);
  });

  it("rolls back the composer if durable stash persistence fails", async () => {
    useComposerDraftStore.getState().setPrompt(sourceThreadId, "Never lose this");
    baseStorage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const result = await useComposerDraftStore.getState().stashPromptDraft({
      threadId: sourceThreadId,
      projectId,
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(useComposerDraftStore.getState().draftsByThreadId[sourceThreadId]?.prompt).toBe(
      "Never lose this",
    );
    expect(useComposerDraftStore.getState().promptStashes).toEqual([]);
  });

  it("rejects image-heavy stashes before they can exhaust shared draft storage", async () => {
    const image = makeImage({ id: "oversized-stash", previewUrl: "blob:oversized-stash" });
    useComposerDraftStore.getState().addImage(sourceThreadId, image);
    useComposerDraftStore.getState().syncPersistedAttachments(sourceThreadId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: `data:image/png;base64,${"a".repeat(3_000_001)}`,
      },
    ]);

    const result = await useComposerDraftStore.getState().stashPromptDraft({
      threadId: sourceThreadId,
      projectId,
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(useComposerDraftStore.getState().draftsByThreadId[sourceThreadId]?.images).toHaveLength(
      1,
    );
    expect(useComposerDraftStore.getState().promptStashes).toEqual([]);
  });

  it("keeps only the twenty newest saved prompts", async () => {
    for (let index = 0; index < 21; index += 1) {
      useComposerDraftStore.getState().setPrompt(sourceThreadId, `Prompt ${index}`);
      const result = await useComposerDraftStore.getState().stashPromptDraft({
        threadId: sourceThreadId,
        projectId,
      });
      expect(result.status).toBe("stored");
    }

    const stashes = useComposerDraftStore.getState().promptStashes;
    expect(stashes).toHaveLength(20);
    expect(stashes[0]?.preview).toBe("Prompt 20");
    expect(stashes.at(-1)?.preview).toBe("Prompt 1");
  });
});

describe("composerDraftStore file paths", () => {
  const threadId = ThreadId.makeUnsafe("thread-files");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("deduplicates exact file paths while preserving insertion order", () => {
    useComposerDraftStore
      .getState()
      .addFilePaths(threadId, ["/repo/src/a.ts", "/repo/src/a.ts", "/repo/src/b.ts"]);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.filePaths).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ]);
  });

  it("removes file paths from the draft", () => {
    useComposerDraftStore.getState().addFilePaths(threadId, ["/repo/src/a.ts", "/repo/src/b.ts"]);
    useComposerDraftStore.getState().removeFilePath(threadId, "/repo/src/a.ts");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.filePaths).toEqual([
      "/repo/src/b.ts",
    ]);
  });

  it("replaces file paths with the normalized set when setFilePaths is used", () => {
    useComposerDraftStore.getState().addFilePaths(threadId, ["/repo/src/a.ts"]);
    useComposerDraftStore
      .getState()
      .setFilePaths(threadId, ["/repo/src/b.ts", "/repo/src/b.ts", "/repo/src/c.ts"]);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.filePaths).toEqual([
      "/repo/src/b.ts",
      "/repo/src/c.ts",
    ]);
  });
});

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadId,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadId,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("persists terminal context text so restored drafts remain sendable", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<
        string,
        {
          filePaths?: string[];
          terminalContexts?: Array<Record<string, unknown>>;
        }
      >;
    };

    expect(
      persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(persistedState.draftsByThreadId?.[threadId]?.filePaths).toBeUndefined();
    expect(persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0]?.text).toBe(
      "git status\nOn branch main",
    );
  });

  it("persists and hydrates file paths", () => {
    useComposerDraftStore
      .getState()
      .addFilePaths(threadId, ["/repo/path with spaces/file.ts", "/repo/src/another.ts"]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { filePaths?: string[] }>;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.filePaths).toEqual([
      "/repo/path with spaces/file.ts",
      "/repo/src/another.ts",
    ]);

    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: [],
            filePaths: ["/repo/path with spaces/file.ts", "/repo/src/another.ts"],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]?.filePaths).toEqual([
      "/repo/path with spaces/file.ts",
      "/repo/src/another.ts",
    ]);
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "orphan me");

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("keeps local and worktree draft threads for the same project separate", () => {
    const store = useComposerDraftStore.getState();
    const localThreadId = ThreadId.makeUnsafe("thread-local");
    const worktreeThreadId = ThreadId.makeUnsafe("thread-worktree");

    store.setProjectDraftThreadId(projectId, localThreadId, {
      envMode: "local",
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.setPrompt(localThreadId, "local draft");
    store.setProjectDraftThreadId(projectId, worktreeThreadId, {
      envMode: "worktree",
      worktreePath: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    store.setPrompt(worktreeThreadId, "worktree draft");

    expect(
      useComposerDraftStore
        .getState()
        .getDraftThreadByProjectId(projectId, { envMode: "local", worktreePath: null })?.threadId,
    ).toBe(localThreadId);
    expect(
      useComposerDraftStore
        .getState()
        .getDraftThreadByProjectId(projectId, { envMode: "worktree", worktreePath: null })
        ?.threadId,
    ).toBe(worktreeThreadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[localThreadId]?.prompt).toBe(
      "local draft",
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[worktreeThreadId]?.prompt).toBe(
      "worktree draft",
    );
  });

  it("uses printable project draft keys while still reading legacy keys", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);

    expect(Object.keys(useComposerDraftStore.getState().projectDraftThreadIdByProjectId)).toEqual([
      `${projectId}::local`,
    ]);

    useComposerDraftStore.setState({
      projectDraftThreadIdByProjectId: {
        [`${projectId}\u0000local`]: threadId,
      },
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
  });

  it("chooses a deterministic latest project draft when createdAt values tie", () => {
    const store = useComposerDraftStore.getState();
    const lowerThreadId = ThreadId.makeUnsafe("thread-a");
    const higherThreadId = ThreadId.makeUnsafe("thread-z");
    const createdAt = "2026-01-01T00:00:00.000Z";

    store.setProjectDraftThreadId(projectId, higherThreadId, {
      envMode: "worktree",
      createdAt,
    });
    store.setProjectDraftThreadId(projectId, lowerThreadId, {
      envMode: "local",
      createdAt,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      higherThreadId,
    );
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, threadId);
    store.setPrompt(threadId, "keep me");

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(threadId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("prunes orphaned project draft mappings and draft threads together", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "keep me");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(otherThreadId, "remove me");

    pruneOrphanedDraftThreads(new Set([projectId]));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]).toBeUndefined();
  });
});

describe("composerDraftStore codex fast mode", () => {
  const threadId = ThreadId.makeUnsafe("thread-service-tier");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("stores codex fast mode in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setCodexFastMode(threadId, true);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.codexFastMode).toBe(true);
  });

  it("clears codex fast mode when reset to the default", () => {
    const store = useComposerDraftStore.getState();
    store.setCodexFastMode(threadId, true);
    store.setCodexFastMode(threadId, false);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore setModel", () => {
  const threadId = ThreadId.makeUnsafe("thread-model");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("keeps explicit DEFAULT_MODEL overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModel(threadId, "gpt-5.3-codex");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.model).toBe(
      "gpt-5.3-codex",
    );
  });
});

describe("composerDraftStore setProvider", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("persists provider-only selection even when prompt/model are empty", () => {
    const store = useComposerDraftStore.getState();

    store.setProvider(threadId, "codex");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.provider).toBe("codex");
  });

  it("removes empty provider-only draft when provider is reset", () => {
    const store = useComposerDraftStore.getState();

    store.setProvider(threadId, "codex");
    store.setProvider(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("stores an exact provider instance and clears it when the driver changes", () => {
    const store = useComposerDraftStore.getState();
    const instanceId = ProviderInstanceId.make("codex_personal");

    store.setProvider(threadId, "codex");
    store.setProviderInstance(threadId, instanceId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      provider: "codex",
      providerInstanceId: instanceId,
    });

    store.setProvider(threadId, "claudeAgent");
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.providerInstanceId,
    ).toBeNull();
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it.each(["auto-accept-edits", "auto"] as const)(
    "persists the %s runtime mode without dropping it",
    (runtimeMode) => {
      useComposerDraftStore.getState().setRuntimeMode(threadId, runtimeMode);

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
        runtimeMode,
      );
    },
  );

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "plan");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "plan",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore setModelOptions", () => {
  const threadId = ThreadId.makeUnsafe("thread-model-options");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("treats reordered model option keys as unchanged", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(threadId, {
      claudeAgent: {
        effort: "max",
        fastMode: true,
      },
    });
    const firstDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    store.setModelOptions(threadId, {
      claudeAgent: {
        fastMode: true,
        effort: "max",
      },
    });
    const secondDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    expect(secondDraft).toBe(firstDraft);
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});

describe("mergePersistedRecords", () => {
  it("keeps an unsaved local entry while accepting unrelated remote-window changes", () => {
    const base = {
      "thread-a": { prompt: "saved in A" },
      "thread-b": { prompt: "saved in B" },
    };
    const local = {
      ...base,
      "thread-a": { prompt: "typing in A" },
    };
    const remote = {
      ...base,
      "thread-b": { prompt: "saved by window B" },
      "thread-c": { prompt: "created by window B" },
    };

    expect(mergePersistedRecords(base, local, remote)).toEqual({
      "thread-a": { prompt: "typing in A" },
      "thread-b": { prompt: "saved by window B" },
      "thread-c": { prompt: "created by window B" },
    });
  });
});
