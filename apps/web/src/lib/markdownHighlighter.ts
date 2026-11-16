import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName } from "./diffRendering";

export type MarkdownHighlighter = Pick<DiffsHighlighter, "codeToHtml">;

export function getMarkdownHighlighter(language: string): Promise<MarkdownHighlighter> {
  return getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error: unknown) => {
    if (language === "text") {
      throw error;
    }
    return getMarkdownHighlighter("text");
  });
}
