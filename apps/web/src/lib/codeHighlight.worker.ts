import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import type {
  CodeHighlightWorkerRequest,
  CodeHighlightWorkerResponse,
} from "./codeHighlightWorkerClient";

// Grammars and themes are resolved on the main thread and sent once per
// worker, so this bundle carries only Shiki's core, not every grammar loader.
// Jobs run one at a time.
const queue: Array<Extract<CodeHighlightWorkerRequest, { type: "highlight" }>> = [];
/**
 * Queued jobs the client cancelled. They still load the grammar and theme
 * they carry: the client records those as sent and won't send them again.
 */
const cancelled = new Set<number>();
let running = false;
let highlighter: Promise<HighlighterCore> | null = null;

function respond(response: CodeHighlightWorkerResponse): void {
  self.postMessage(response);
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [],
    langs: [],
    // Oniguruma, like PREFERRED_HIGHLIGHTER: the JS regex engine can
    // backtrack catastrophically and spin until the job times out.
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighter;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        const instance = await getHighlighter();
        for (const theme of job.resolvedThemes) {
          if (!instance.getLoadedThemes().includes(theme.name)) instance.loadThemeSync(theme);
        }
        for (const language of job.resolvedLanguages) {
          if (!instance.getLoadedLanguages().includes(language.name)) {
            instance.loadLanguageSync(language.data);
          }
        }
        if (cancelled.delete(job.id)) {
          respond({ type: "cancelled", id: job.id });
          continue;
        }
        const html = instance.codeToHtml(job.code, { lang: job.language, theme: job.theme });
        respond({ type: "result", id: job.id, html });
      } catch (error) {
        // Also for cancelled jobs: the client un-records the assets it sent.
        cancelled.delete(job.id);
        respond({
          type: "error",
          id: job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
  }
}

self.addEventListener("message", (event: MessageEvent<CodeHighlightWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (queue.some((job) => job.id === request.id)) cancelled.add(request.id);
    return;
  }
  queue.push(request);
  void drain();
});
