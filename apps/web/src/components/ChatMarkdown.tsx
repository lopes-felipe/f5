import { suffixSince, type TextRevision } from "../lib/streamingTextRevision";
import { useOpenLink } from "../hooks/useOpenLink";
import { PrLinkPreview } from "./prHub/PrLinkPreview";
import { ChatAssetImage } from "./ChatAssetImage";
import { useContext } from "react";
import { RepositoryLinks } from "../repositoryLinkContext";
import { remarkIssueReferences } from "../lib/remarkIssueReferences";
import { remarkKeepWindowsPathDestinations } from "../lib/remarkWindowsPathDestinations";
import { GitHubIcon } from "./Icons";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
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
import { useDiffWordWrap } from "../appSettings";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { classifyCodeHighlight, normalizeFenceLanguage } from "../lib/codeHighlightPolicy";
import { highlightCodeInWorker } from "../lib/codeHighlightWorkerClient";
import type { MarkdownHighlighter } from "../lib/markdownHighlighter";
import {
  EMPTY_STREAMING_MARKDOWN_STATE,
  advanceStreamingMarkdown,
  type StreamingMarkdownBlockKind,
  type StreamingMarkdownState,
} from "../lib/streamingMarkdown";
import { useFileNavigation } from "../fileNavigationContext";
import { useTheme } from "../hooks/useTheme";
import {
  collectMarkdownLinkHrefs,
  chatMarkdownUrlTransform,
  isMarkdownFileLinkLabel,
  resolveMarkdownFileLinkMeta,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import { inferEntryKindFromPath } from "../vscode-icons";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { SurfaceErrorBoundary } from "./ui/SurfaceErrorBoundary";
import { MermaidDiagram } from "./chat/MermaidDiagram";
import { useTerminalCommand } from "../terminalCommandContext";
import { hasClosedCodeFence, runnableShellCode } from "../lib/shellCodeBlock";

/**
 * `default` renders trusted assistant output. `external-bot` renders content an
 * outside agent wrote: no raw HTML, images as text, no local-file links, no
 * automatic PR or file previews, and only HTTPS links.
 */
export type ChatMarkdownPolicy = "default" | "external-bot";

interface ChatMarkdownProps {
  textRevision?: TextRevision | undefined;
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  policy?: ChatMarkdownPolicy;
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
/** Languages with a retained highlighter promise, least recently used first. */
const MAX_RETAINED_HIGHLIGHTER_LANGUAGES = 24;
const highlighterPromiseCache = new Map<string, Promise<MarkdownHighlighter>>();

function extractFenceLanguage(className: string | undefined): string {
  return normalizeFenceLanguage(className?.match(CODE_FENCE_LANGUAGE_REGEX)?.[1]);
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

/**
 * Exact cache identity: the full source is part of the key, so two sources
 * can never share an entry the way a hash-plus-length key could.
 */
export function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  return `${language}\u0000${themeName}\u0000${code}`;
}

/** Charges the key (which holds the full source) as well as the HTML, both UTF-16. */
function estimateHighlightedSize(html: string, cacheKey: string): number {
  return (html.length + cacheKey.length) * 2;
}

function getHighlighterPromise(language: string): Promise<MarkdownHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) {
    highlighterPromiseCache.delete(language);
    highlighterPromiseCache.set(language, cached);
    return cached;
  }

  const promise = import("../lib/markdownHighlighter")
    .then((module) => module.getMarkdownHighlighter(language))
    .catch((error: unknown) => {
      highlighterPromiseCache.delete(language);
      throw error;
    });
  highlighterPromiseCache.set(language, promise);
  if (highlighterPromiseCache.size > MAX_RETAINED_HIGHLIGHTER_LANGUAGES) {
    const oldest = highlighterPromiseCache.keys().next().value;
    if (oldest !== undefined) highlighterPromiseCache.delete(oldest);
  }
  return promise;
}

function MarkdownCodeBlock({
  code,
  command,
  children,
}: {
  code: string;
  command?: string | null;
  children: ReactNode;
}) {
  const runCommand = useTerminalCommand();
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [runError, setRunError] = useState(false);
  const wordWrap = useDiffWordWrap();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    void writeTextToClipboard(code)
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
    <div
      className={`chat-markdown-codeblock${wordWrap ? " chat-markdown-codeblock-wrap" : ""}`}
      data-word-wrap={wordWrap ? "true" : "false"}
    >
      {runCommand && command ? (
        <div className="flex items-center gap-2 px-3 pt-2 pr-12 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={running}
            className="underline underline-offset-2 disabled:opacity-50"
            onClick={() => {
              if (runningRef.current) return;
              runningRef.current = true;
              setRunning(true);
              setRunError(false);
              void runCommand(command)
                .catch(() => setRunError(true))
                .finally(() => {
                  runningRef.current = false;
                  setRunning(false);
                });
            }}
          >
            Run in terminal
          </button>
          {runError ? <span role="status">Could not run command. Try again.</span> : null}
        </div>
      ) : null}
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
  /** Unhighlighted rendering, shown while a worker job runs or after it fails. */
  plain?: ReactNode;
}

function ShikiHtml({ html }: { html: string }) {
  return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Cache hits and misses render different components, so each keeps a fixed
 * hook order when a block flips from miss to hit between renders.
 */
export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  plain,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);

  const mode = classifyCodeHighlight(code);
  if (mode !== "inline") {
    // Stays mounted across streaming deltas and cache hits, so a "Highlight
    // code" opt-in on a growing block is kept.
    return (
      <WorkerHighlightedCode
        cacheKey={cacheKey}
        cachedHtml={cachedHighlightedHtml}
        code={code}
        language={language}
        themeName={themeName}
        plain={plain ?? <pre>{code}</pre>}
        onDemand={mode === "on-demand"}
      />
    );
  }

  if (cachedHighlightedHtml != null) {
    return <ShikiHtml html={cachedHighlightedHtml} />;
  }

  return (
    <HighlightOnCacheMiss
      cacheKey={cacheKey}
      code={code}
      language={language}
      themeName={themeName}
    />
  );
}

function HighlightOnCacheMiss({
  cacheKey,
  code,
  language,
  themeName,
}: {
  cacheKey: string;
  code: string;
  language: string;
  themeName: DiffThemeName;
}) {
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
      estimateHighlightedSize(highlightedHtml, cacheKey),
    );
  }, [cacheKey, highlightedHtml]);

  return <ShikiHtml html={highlightedHtml} />;
}

/**
 * Large blocks highlight in a web worker, huge ones only on request, so neither
 * blocks the main thread. Plain text shows meanwhile and if the worker fails.
 */
function WorkerHighlightedCode({
  cacheKey,
  cachedHtml,
  code,
  language,
  themeName,
  plain,
  onDemand,
}: {
  cacheKey: string;
  cachedHtml: string | null;
  code: string;
  language: string;
  themeName: DiffThemeName;
  plain: ReactNode;
  onDemand: boolean;
}) {
  const [optedIn, setOptedIn] = useState(false);
  const requested = !onDemand || optedIn;
  // Tagged with the content it belongs to: deltas change `cacheKey` in place.
  const [result, setResult] = useState<{
    cacheKey: string;
    status: "highlighted" | "failed";
    html: string;
  } | null>(null);
  const current = result?.cacheKey === cacheKey ? result : null;

  useEffect(() => {
    if (!requested || cachedHtml != null) return;
    const controller = new AbortController();
    highlightCodeInWorker({ code, language, theme: themeName, signal: controller.signal }).then(
      (html) => {
        highlightedCodeCache.set(cacheKey, html, estimateHighlightedSize(html, cacheKey));
        setResult({ cacheKey, status: "highlighted", html });
      },
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        console.warn(
          `Code highlighting failed for language "${language}", showing plain text.`,
          error instanceof Error ? error.message : error,
        );
        setResult({ cacheKey, status: "failed", html: "" });
      },
    );
    return () => controller.abort();
  }, [cacheKey, cachedHtml, code, language, requested, themeName]);

  const html = cachedHtml ?? (current?.status === "highlighted" ? current.html : null);
  if (html != null) {
    return <ShikiHtml html={html} />;
  }
  return (
    <div
      className="chat-markdown-plain-code"
      data-code-highlight={
        current?.status === "failed" ? "failed" : requested ? "pending" : "on-demand"
      }
    >
      {!requested ? (
        <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
          <span>Large block shown as plain text.</span>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setOptedIn(true)}
          >
            Highlight code
          </button>
        </div>
      ) : null}
      {plain}
    </div>
  );
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
    <div className="chat-markdown w-full min-w-0 leading-relaxed text-foreground">
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
  const openLink = useOpenLink();
  const repositoryLinks = useContext(RepositoryLinks);
  const { text, cwd, mode } = props;
  const wordWrap = useDiffWordWrap();
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
      img({ src, alt }) {
        return typeof src === "string" ? (
          <ChatAssetImage src={src} alt={alt ?? ""} cwd={cwd} />
        ) : null;
      },
      a({ node: _node, href, children, ...props }) {
        // Resolve meta directly from the href so reference-style links and
        // balanced-paren hrefs (which the regex pre-scan misses) still
        // render as file chips — the pre-scan is only used for collision
        // disambiguation.
        const meta = href ? resolveMarkdownFileLinkMeta(href, cwd) : null;
        if (!meta || !href) {
          if (
            href &&
            /^https:\/\/[^/]+\/.*\/(?:pull|pulls|pull-requests|pullrequests|merge_requests|pullrequest)\/\d+(?:[/?#]|$)/.test(
              href,
            )
          )
            return <PrLinkPreview url={href}>{children}</PrLinkPreview>;
          let isGitHub = false;
          try {
            isGitHub = href !== undefined && new URL(href).hostname === "github.com";
          } catch {
            /* Relative and incomplete links have no host. */
          }
          return (
            <a
              {...props}
              // An image-only link (a badge, a screenshot) gets no underline.
              data-markdown-image-link={nodeToPlainText(children).trim() === "" || undefined}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (!href || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                  return;
                event.preventDefault();
                // Option/Alt-click leaves the app like the other modifiers. Chromium would
                // otherwise turn it into a download, so open it here while the key is still
                // down, which lets link routers such as Finicky read it.
                void openLink(href, event.altKey ? { external: true } : undefined).catch(
                  () => undefined,
                );
              }}
            >
              {isGitHub ? (
                <GitHubIcon aria-hidden="true" className="mr-1 inline size-3 align-baseline" />
              ) : null}
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

        const chip = (
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
        // `[validates the input](src/a.ts:12)` keeps its prose next to the chip.
        return isMarkdownFileLinkLabel(nodeToPlainText(children), meta) ? (
          chip
        ) : (
          <span>
            {children} {chip}
          </span>
        );
      },
      pre({ node, children, ...props }) {
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

        if (extractFenceLanguage(codeBlock.className) === "mermaid") {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <MermaidDiagram
                source={codeBlock.code}
                theme={resolvedTheme}
                code={<pre {...props}>{children}</pre>}
              />
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock
            code={codeBlock.code}
            command={
              hasClosedCodeFence(text, node?.position?.start.offset, node?.position?.end.offset)
                ? runnableShellCode(extractFenceLanguage(codeBlock.className), codeBlock.code)
                : null
            }
          >
            {/* Not keyed on the code: a failed highlighter load would retry on every streaming delta. */}
            <SurfaceErrorBoundary
              name="code-highlight"
              resetKeys={[codeBlock.className, diffThemeName]}
              fallback={<pre {...props}>{children}</pre>}
            >
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  plain={<pre {...props}>{children}</pre>}
                />
              </Suspense>
            </SurfaceErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
      ol({ node, children, start = 1, ...props }) {
        const count =
          node?.children.filter((child) => child.type === "element" && child.tagName === "li")
            .length ?? Children.count(children);
        const widest = Math.max(
          String(start).length,
          String(start + Math.max(0, count - 1)).length,
        );
        return (
          <ol {...props} start={start} style={{ paddingInlineStart: `calc(${widest}ch + 1.25em)` }}>
            {children}
          </ol>
        );
      },
      table({ node: _node, children, ...props }) {
        return (
          <div
            className={`chat-markdown-table-container${wordWrap ? " chat-markdown-table-wrap" : ""}`}
            data-word-wrap={wordWrap ? "true" : "false"}
          >
            <table {...props}>{children}</table>
          </div>
        );
      },
    }),
    [cwd, diffThemeName, disambiguatorMap, mode, resolvedTheme, wordWrap, openLink, text],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkKeepWindowsPathDestinations,
        [remarkIssueReferences, repositoryLinks],
      ]}
      urlTransform={chatMarkdownUrlTransform}
      components={markdownComponents}
    >
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
  textRevision?: TextRevision,
): {
  readonly committedState: StreamingMarkdownState;
  readonly liveActiveText: string;
  readonly fallbackToRawMessage: boolean;
} | null {
  const [committedState, setCommittedState] = useState<StreamingMarkdownState>(() =>
    isStreaming
      ? advanceStreamingMarkdown(null, text, textRevision)
      : EMPTY_STREAMING_MARKDOWN_STATE,
  );
  const committedStateRef = useRef(committedState);
  const latestTextRef = useRef(text);
  const latestRevisionRef = useRef(textRevision);
  latestRevisionRef.current = textRevision;
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
      const nextState = advanceStreamingMarkdown(
        committedStateRef.current,
        latestTextRef.current,
        latestRevisionRef.current,
      );
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
      (suffixSince(committedStateRef.current.textRevision, textRevision) === null &&
        (textRevision !== undefined ||
          committedStateRef.current.textRevision !== undefined ||
          !text.startsWith(committedStateRef.current.text)));

    if (needsImmediateCommit) {
      commit();
      return;
    }

    if (timerRef.current != null) {
      return;
    }

    timerRef.current = setTimeout(commit, STREAMING_PARSE_DELAY_MS);
  }, [isStreaming, text, textRevision]);

  if (!isStreaming) {
    return null;
  }

  const suffix = suffixSince(committedState.textRevision, textRevision);
  if (
    suffix === null &&
    (textRevision !== undefined ||
      committedState.textRevision !== undefined ||
      !text.startsWith(committedState.text))
  ) {
    return {
      committedState: EMPTY_STREAMING_MARKDOWN_STATE,
      liveActiveText: text,
      fallbackToRawMessage: true,
    };
  }

  return {
    committedState,
    liveActiveText: `${committedState.activeBlock}${suffix ?? text.slice(committedState.text.length)}`,
    fallbackToRawMessage: false,
  };
}

/** The only links external-bot content may carry: absolute HTTPS URLs. */
export function externalBotLinkHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const EXTERNAL_BOT_COMPONENTS: Components = {
  img({ src, alt }) {
    const label = alt?.trim() || "image";
    return <span>{`[${label}${typeof src === "string" ? `: ${src}` : ""}]`}</span>;
  },
  a({ node: _node, href, children }) {
    const safeHref = externalBotLinkHref(href);
    if (!safeHref) return <span>{children}</span>;
    return (
      <a href={safeHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const ExternalBotMarkdown = memo(function ExternalBotMarkdown(props: { text: string }) {
  return (
    <MarkdownContainer>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={EXTERNAL_BOT_COMPONENTS} skipHtml>
        {props.text}
      </ReactMarkdown>
    </MarkdownContainer>
  );
});

function ChatMarkdown({
  text,
  textRevision,
  cwd,
  isStreaming = false,
  policy = "default",
}: ChatMarkdownProps) {
  if (policy === "external-bot") return <ExternalBotMarkdown text={text} />;
  return (
    <TrustedChatMarkdown
      text={text}
      textRevision={textRevision}
      cwd={cwd}
      isStreaming={isStreaming}
    />
  );
}

function TrustedChatMarkdown({ text, textRevision, cwd, isStreaming = false }: ChatMarkdownProps) {
  const streamingState = useStreamingMarkdownState(text, isStreaming, textRevision);

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
