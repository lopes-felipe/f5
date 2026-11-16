import { bundledLanguages, bundledThemes } from "shiki";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  CodeHighlightWorkerRequest,
  CodeHighlightWorkerResponse,
} from "./codeHighlightWorkerClient";

const responses: CodeHighlightWorkerResponse[] = [];
const listeners: Array<(event: MessageEvent<CodeHighlightWorkerRequest>) => void> = [];

type HighlightRequest = Extract<CodeHighlightWorkerRequest, { type: "highlight" }>;

function post(request: CodeHighlightWorkerRequest): void {
  for (const listener of listeners) listener({ data: request } as MessageEvent);
}

function highlight(
  id: number,
  language: string,
  assets: Pick<HighlightRequest, "resolvedLanguages" | "resolvedThemes">,
): void {
  // Shiki's bundled theme stands in for pierre's JSON theme, which Node can't import.
  post({
    type: "highlight",
    id,
    code: "const a = 1;",
    language,
    theme: "github-dark" as HighlightRequest["theme"],
    ...assets,
  });
}

beforeAll(async () => {
  vi.stubGlobal("self", {
    postMessage: (response: CodeHighlightWorkerResponse) => responses.push(response),
    addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
      listeners.push(listener),
  });
  await import("./codeHighlight.worker");
});

describe("code highlight worker", () => {
  it("loads the grammar a cancelled queued job carried", async () => {
    const theme = (await bundledThemes["github-dark"]()).default;
    const typescript = {
      name: "typescript",
      data: (await bundledLanguages.typescript()).default,
    } as unknown as HighlightRequest["resolvedLanguages"][number];

    // Job 1 runs; job 2 waits behind it carrying the TypeScript grammar and
    // is cancelled. The client won't send that grammar again for job 3.
    highlight(1, "text", {
      resolvedLanguages: [],
      resolvedThemes: [theme as HighlightRequest["resolvedThemes"][number]],
    });
    highlight(2, "typescript", { resolvedLanguages: [typescript], resolvedThemes: [] });
    post({ type: "cancel", id: 2 });
    highlight(3, "typescript", { resolvedLanguages: [], resolvedThemes: [] });

    await vi.waitFor(() => expect(responses).toHaveLength(3), { timeout: 10_000 });
    expect(responses.map((response) => [response.id, response.type])).toEqual([
      [1, "result"],
      [2, "cancelled"],
      [3, "result"],
    ]);
  });
});
