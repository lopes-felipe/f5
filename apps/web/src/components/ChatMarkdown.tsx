import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  isValidElement,
  startTransition,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import {
  EMPTY_STREAMING_MARKDOWN_STATE,
  advanceStreamingMarkdown,
  type StreamingMarkdownBlockKind,
  type StreamingMarkdownState,
} from "../lib/streamingMarkdown";
import { useFileNavigation } from "../fileNavigationContext";
import { useTheme } from "../hooks/useTheme";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import { inferEntryKindFromPath } from "../vscode-icons";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
}

type MarkdownRenderMode = "settled" | "streaming-lite";

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const STREAMING_PARSE_DELAY_MS = 50;
const MAX_STREAMING_ACTIVE_BLOCK_CHARS = 8_000;
const MAX_STREAMING_ACTIVE_BLOCK_LINES = 200;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
}

function SuspenseShikiCodeBlock({ className, code, themeName }: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    highlightedCodeCache.set(
      cacheKey,
      highlightedHtml,
      estimateHighlightedSize(highlightedHtml, code),
    );
  }, [cacheKey, code, highlightedHtml]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

// Matches inline markdown links: `[text](href)` / `[text](href "title")`.
// Used once per message to compute basename-collision disambiguation ahead of
// react-markdown's element-by-element rendering, so each chip's suffix stays
// stable no matter which element renders first.
const MARKDOWN_INLINE_LINK_REGEX = /\[(?:\\.|[^\]\\])*\]\(\s*(<[^>]+>|[^()\s]+)[^)]*\)/g;

function collectMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_INLINE_LINK_REGEX)) {
    const raw = match[1];
    if (!raw) continue;
    const href = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    hrefs.push(href);
  }
  return hrefs;
}

function parentDirDisambiguator(displayPath: string): string | null {
  const normalized = displayPath.replace(/[\\/]+/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const parent = normalized.slice(0, lastSlash);
  const secondLastSlash = parent.lastIndexOf("/");
  return secondLastSlash === -1 ? parent : parent.slice(secondLastSlash + 1);
}

/**
 * Map of href → collision disambiguator for basenames that appear more than
 * once in the same message. Chips without collisions are absent from the map
 * (or map to `null`). The renderer resolves each link's metadata directly
 * from its own `href`, so this map is a pure enhancement — missing from
 * streaming snapshots or forms of markdown links the regex pre-scan doesn't
 * recognize (reference-style, balanced parens) just yields `null` here and
 * still produces a correctly-rendered chip.
 */
function buildDisambiguatorMap(text: string, cwd: string | undefined): Map<string, string | null> {
  const hrefs = collectMarkdownLinkHrefs(text);
  const metasByHref = new Map<string, MarkdownFileLinkMeta>();
  const basenameCounts = new Map<string, number>();

  for (const href of hrefs) {
    if (metasByHref.has(href)) continue;
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    if (!meta) continue;
    metasByHref.set(href, meta);
    basenameCounts.set(meta.basename, (basenameCounts.get(meta.basename) ?? 0) + 1);
  }

  const disambiguators = new Map<string, string | null>();
  for (const [href, meta] of metasByHref) {
    const colliding = (basenameCounts.get(meta.basename) ?? 0) > 1;
    disambiguators.set(href, colliding ? parentDirDisambiguator(meta.displayPath) : null);
  }
  return disambiguators;
}

const EMPTY_DISAMBIGUATOR_MAP: ReadonlyMap<string, string | null> = new Map();

const MarkdownContainer = memo(function MarkdownContainer(props: { children: ReactNode }) {
  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      {props.children}
    </div>
  );
});

const RawMarkdownText = memo(function RawMarkdownText(props: { text: string }) {
  return props.text.length > 0 ? (
    <div className="whitespace-pre-wrap wrap-break-word">{props.text}</div>
  ) : null;
});

const LightweightMarkdownPreview = memo(function LightweightMarkdownPreview(props: {
  text: string;
}) {
  return (
    <MarkdownContainer>
      <RawMarkdownText text={props.text} />
    </MarkdownContainer>
  );
});

const RenderedMarkdownFragment = memo(function RenderedMarkdownFragment(props: {
  text: string;
  cwd: string | undefined;
  mode: MarkdownRenderMode;
}) {
  const { text, cwd, mode } = props;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const handleFileNavigation = useFileNavigation();
  const handleFileNavigationRef = useRef(handleFileNavigation);
  useEffect(() => {
    handleFileNavigationRef.current = handleFileNavigation;
  }, [handleFileNavigation]);
  // The disambiguator map is an O(N·K) scan over the whole message, so we
  // skip it for empty text and reconcile once content is present. Absence of
  // an entry is fine — chips render correctly without a parent-dir suffix.
  const disambiguatorMap = useMemo(
    () =>
      mode === "settled" && text.length > 0
        ? buildDisambiguatorMap(text, cwd)
        : EMPTY_DISAMBIGUATOR_MAP,
    [text, cwd, mode],
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, children, ...props }) {
        // Resolve meta directly from the href so reference-style links and
        // balanced-paren hrefs (which the regex pre-scan misses) still
        // render as file chips — the pre-scan is only used for collision
        // disambiguation.
        const meta = href ? resolveMarkdownFileLinkMeta(href, cwd) : null;
        if (!meta || !href) {
          return (
            <a {...props} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }

        const disambiguator = disambiguatorMap.get(href) ?? null;
        const positionSuffix = meta.line
          ? `:${meta.line}${meta.column ? `:${meta.column}` : ""}`
          : "";
        const tooltipText = `${meta.displayPath}${positionSuffix}`;
        const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (handleFileNavigationRef.current(meta.targetPath)) {
            return;
          }
          const api = readNativeApi();
          if (api) {
            void openInPreferredEditor(api, meta.targetPath);
          } else {
            console.warn("Native API not found. Unable to open file in editor.");
          }
        };

        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    {...props}
                    // Keep the original href (typically a `file://` URI) so
                    // cmd/ctrl-click or middle-click falls back to the
                    // browser's default file-URL handling rather than
                    // navigating inside the SPA to `<app-origin>/Users/…`
                    // and hitting a 404. The rewritten form is only useful
                    // for tooltip display, which `TooltipPopup` already
                    // handles below.
                    href={href}
                    className="chat-markdown-file-link"
                    onClick={handleClick}
                  />
                }
              >
                <VscodeEntryIcon
                  pathValue={meta.filePath}
                  kind={inferEntryKindFromPath(meta.filePath)}
                  theme={resolvedTheme === "dark" ? "dark" : "light"}
                  className="chat-markdown-file-link-icon"
                />
                <span className="chat-markdown-file-link-label">{meta.basename}</span>
                {meta.line ? (
                  <span className="chat-markdown-file-link-position">{positionSuffix}</span>
                ) : null}
                {disambiguator ? (
                  <span className="chat-markdown-file-link-disambiguator">{disambiguator}</span>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup>{tooltipText}</TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        if (mode === "streaming-lite") {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <pre {...props}>{children}</pre>
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [cwd, diffThemeName, disambiguatorMap, mode, resolvedTheme],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
});

const RenderedMarkdown = memo(function RenderedMarkdown(props: {
  text: string;
  cwd: string | undefined;
  mode?: MarkdownRenderMode;
}) {
  const { text, cwd, mode = "settled" } = props;
  return (
    <MarkdownContainer>
      <RenderedMarkdownFragment text={text} cwd={cwd} mode={mode} />
    </MarkdownContainer>
  );
});

const SealedMarkdownBlocks = memo(function SealedMarkdownBlocks(props: {
  blocks: readonly string[];
  cwd: string | undefined;
}) {
  const { blocks, cwd } = props;
  let cumulativeBlockLength = 0;

  return (
    <>
      {blocks.map((block) => {
        cumulativeBlockLength += block.length;
        return (
          <RenderedMarkdownFragment
            key={`sealed:${cumulativeBlockLength}:${fnv1a32(block).toString(36)}`}
            text={block}
            cwd={cwd}
            mode="streaming-lite"
          />
        );
      })}
    </>
  );
});

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines += 1;
    }
  }
  return lines;
}

function shouldRenderActiveBlockAsRawPreview(
  kind: StreamingMarkdownBlockKind | null,
  text: string,
): boolean {
  return (
    kind === "fenced-code" ||
    text.length > MAX_STREAMING_ACTIVE_BLOCK_CHARS ||
    countLines(text) > MAX_STREAMING_ACTIVE_BLOCK_LINES
  );
}

function useStreamingMarkdownState(
  text: string,
  isStreaming: boolean,
): {
  readonly committedState: StreamingMarkdownState;
  readonly liveActiveText: string;
  readonly fallbackToRawMessage: boolean;
} | null {
  const [committedState, setCommittedState] = useState<StreamingMarkdownState>(() =>
    isStreaming ? advanceStreamingMarkdown(null, text) : EMPTY_STREAMING_MARKDOWN_STATE,
  );
  const committedStateRef = useRef(committedState);
  const latestTextRef = useRef(text);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestTextRef.current = text;

  useEffect(() => {
    committedStateRef.current = committedState;
  }, [committedState]);

  useEffect(
    () => () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const clearPendingCommit = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const commit = () => {
      clearPendingCommit();
      const nextState = advanceStreamingMarkdown(committedStateRef.current, latestTextRef.current);
      if (nextState === committedStateRef.current) {
        return;
      }
      committedStateRef.current = nextState;
      startTransition(() => {
        setCommittedState(nextState);
      });
    };

    if (!isStreaming) {
      clearPendingCommit();
      if (committedStateRef.current !== EMPTY_STREAMING_MARKDOWN_STATE) {
        committedStateRef.current = EMPTY_STREAMING_MARKDOWN_STATE;
        startTransition(() => {
          setCommittedState(EMPTY_STREAMING_MARKDOWN_STATE);
        });
      }
      return;
    }

    if (committedStateRef.current.text === text) {
      return;
    }

    const needsImmediateCommit =
      committedStateRef.current.text.length === 0 ||
      !text.startsWith(committedStateRef.current.text);

    if (needsImmediateCommit) {
      commit();
      return;
    }

    if (timerRef.current != null) {
      return;
    }

    timerRef.current = setTimeout(commit, STREAMING_PARSE_DELAY_MS);
  }, [isStreaming, text]);

  if (!isStreaming) {
    return null;
  }

  if (!text.startsWith(committedState.text)) {
    return {
      committedState: EMPTY_STREAMING_MARKDOWN_STATE,
      liveActiveText: text,
      fallbackToRawMessage: true,
    };
  }

  return {
    committedState,
    liveActiveText: `${committedState.activeBlock}${text.slice(committedState.text.length)}`,
    fallbackToRawMessage: false,
  };
}

function ChatMarkdown({ text, cwd, isStreaming = false }: ChatMarkdownProps) {
  const streamingState = useStreamingMarkdownState(text, isStreaming);

  if (streamingState) {
    if (streamingState.fallbackToRawMessage) {
      return <LightweightMarkdownPreview text={text} />;
    }

    const shouldRenderRawActiveBlock = shouldRenderActiveBlockAsRawPreview(
      streamingState.committedState.activeBlockKind,
      streamingState.liveActiveText,
    );

    return (
      <MarkdownContainer>
        <SealedMarkdownBlocks blocks={streamingState.committedState.sealedBlocks} cwd={cwd} />
        {streamingState.liveActiveText.length > 0 ? (
          shouldRenderRawActiveBlock ? (
            <RawMarkdownText text={streamingState.liveActiveText} />
          ) : (
            <RenderedMarkdownFragment
              text={streamingState.liveActiveText}
              cwd={cwd}
              mode="streaming-lite"
            />
          )
        ) : null}
      </MarkdownContainer>
    );
  }

  return <RenderedMarkdown text={text} cwd={cwd} mode="settled" />;
}

export default memo(ChatMarkdown);
