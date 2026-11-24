import { Suspense, useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useOpenWorkspaceFile } from "../../hooks/useOpenWorkspaceFile";
import type { AnsiColor, AnsiSpan, AnsiStyle } from "../../lib/ansiOutput";
import { classifyCodeHighlight } from "../../lib/codeHighlightPolicy";
import {
  classifyCommandOutput,
  type ClassifyCommandOutputInput,
  type CommandOutputPresentation,
  type DiffFileSection,
  type MatchRange,
  type OutputSection,
  type SearchSegment,
} from "../../lib/commandOutputPresentation";
import { cn } from "~/lib/utils";
import { SurfaceErrorBoundary } from "../ui/SurfaceErrorBoundary";
import { syntaxTokenStyle, useSyntaxTokenLines, type SyntaxToken } from "./HighlightedTokens";

const OUTPUT_TEXT_CLASS_NAME = "font-mono text-[length:var(--f5-chat-font-size)] text-foreground";
const LINE_TEXT_CLASS_NAME = "min-h-[1lh] min-w-0 flex-1 whitespace-pre-wrap break-words";
const GUTTER_CLASS_NAME = "shrink-0 select-none pr-3 text-right tabular-nums text-faint-foreground";
const CHIP_CLASS_NAME =
  "inline-flex min-w-0 items-center gap-1 rounded-full border border-border/70 px-1.5 font-mono text-2xs leading-4 text-foreground";
const MARK_CLASS_NAME = "rounded-xs bg-warning/30 text-inherit";

type Theme = "light" | "dark";
type LineRenderer = (index: number, marks?: ReadonlyArray<MatchRange>) => ReactNode;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Splits `text` (starting at `offset` within its line) at match boundaries. */
function withMarks(
  text: string,
  offset: number,
  marks: ReadonlyArray<MatchRange> | undefined,
  render: (piece: string, key: string) => ReactNode,
): ReactNode[] {
  if (!marks || marks.length === 0) return [render(text, String(offset))];
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of marks) {
    const localStart = Math.max(start - offset, cursor);
    const localEnd = Math.min(end - offset, text.length);
    if (localEnd <= localStart) continue;
    if (localStart > cursor) {
      pieces.push(render(text.slice(cursor, localStart), String(offset + cursor)));
    }
    pieces.push(
      <mark key={`m${offset + localStart}`} className={MARK_CLASS_NAME}>
        {render(text.slice(localStart, localEnd), String(offset + localStart))}
      </mark>,
    );
    cursor = localEnd;
  }
  if (cursor < text.length) pieces.push(render(text.slice(cursor), String(offset + cursor)));
  return pieces;
}

function renderTokens(
  tokens: ReadonlyArray<SyntaxToken>,
  marks: ReadonlyArray<MatchRange> | undefined,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lineOffset = 0;
  for (const token of tokens) {
    const style = syntaxTokenStyle(token);
    nodes.push(
      ...withMarks(token.content, lineOffset, marks, (piece, key) => (
        <span key={key} style={style}>
          {piece}
        </span>
      )),
    );
    lineOffset += token.content.length;
  }
  return nodes;
}

function TokenizedLines(props: {
  code: string;
  language: string;
  theme: Theme;
  children: (renderLine: LineRenderer) => ReactNode;
}) {
  const lines = useSyntaxTokenLines(props.code, props.language, props.theme);
  return props.children((index, marks) => renderTokens(lines[index]?.tokens ?? [], marks));
}

function PlainLines(props: { code: string; children: (renderLine: LineRenderer) => ReactNode }) {
  const lines = useMemo(() => props.code.split(/\r?\n/), [props.code]);
  return props.children((index, marks) =>
    withMarks(lines[index] ?? "", 0, marks, (piece, key) => <span key={key}>{piece}</span>),
  );
}

/**
 * Hands `children` a renderer for each line of `code`, syntax highlighted when
 * `highlight` is set and the grammar loads, plain text until then.
 */
function CodeLines(props: {
  code: string;
  language: string;
  theme: Theme;
  highlight: boolean;
  children: (renderLine: LineRenderer) => ReactNode;
}) {
  const plain = <PlainLines code={props.code}>{props.children}</PlainLines>;
  if (!props.highlight || props.language === "text") return plain;
  return (
    <SurfaceErrorBoundary
      name="Command output highlighting"
      fallback={plain}
      resetKeys={[props.code, props.language, props.theme]}
    >
      <Suspense fallback={plain}>
        <TokenizedLines code={props.code} language={props.language} theme={props.theme}>
          {props.children}
        </TokenizedLines>
      </Suspense>
    </SurfaceErrorBoundary>
  );
}

function gutterWidth(maxNumber: number): string {
  return `${String(maxNumber).length + 1}ch`;
}

const GUTTER_BUTTON_SELECTOR = "button[data-gutter-button]";

/**
 * Line-number buttons are one tab stop: the first is in the tab order, and
 * the arrow keys (plus Home and End) move between them.
 */
function handleGutterKeyDown(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  if (!target.matches(GUTTER_BUTTON_SELECTOR)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>(GUTTER_BUTTON_SELECTOR)];
  const index = buttons.indexOf(target);
  const nextIndex =
    event.key === "ArrowDown"
      ? index + 1
      : event.key === "ArrowUp"
        ? index - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : null;
  if (nextIndex === null) return;
  event.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, nextIndex))]?.focus();
}

function LineRow(props: {
  number?: number | null;
  gutter?: string | null;
  onOpenLine?: ((line: number) => void) | null;
  openLabel?: string | undefined;
  /** This row's line button is the block's tab stop. */
  tabStop?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  const { number, gutter, onOpenLine } = props;
  return (
    <div className={cn("flex", props.className)} data-line-number={number ?? undefined}>
      {gutter ? (
        onOpenLine && typeof number === "number" ? (
          <button
            type="button"
            data-gutter-button
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${props.openLabel ?? "Open"} at line ${number}`}
            title={`Open at line ${number}`}
            className={cn(
              GUTTER_CLASS_NAME,
              "rounded-xs outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
            style={{ width: gutter }}
            onClick={() => onOpenLine(number)}
          >
            {number}
          </button>
        ) : (
          <span aria-hidden className={GUTTER_CLASS_NAME} style={{ width: gutter }}>
            {number ?? ""}
          </span>
        )
      ) : null}
      <span className={LINE_TEXT_CLASS_NAME}>{props.children}</span>
    </div>
  );
}

function FileOutput(props: {
  presentation: Extract<CommandOutputPresentation, { kind: "file" }>;
  theme: Theme;
  highlight: boolean;
  openFile: (path: string) => void;
}) {
  const { presentation } = props;
  const lineCount = useMemo(() => presentation.code.split(/\r?\n/).length, [presentation.code]);
  const numbers = presentation.lineNumbers;
  // Numbers only increase, so the last one is the widest.
  const gutter = numbers && numbers.length > 0 ? gutterWidth(numbers[numbers.length - 1]!) : null;
  const { file } = presentation;
  const openPath = file?.filePath ?? null;
  const openLine = openPath ? (line: number) => props.openFile(`${openPath}:${line}`) : null;
  return (
    <CodeLines
      code={presentation.code}
      language={presentation.language}
      theme={props.theme}
      highlight={props.highlight}
    >
      {(renderLine) =>
        Array.from({ length: lineCount }, (_, index) => (
          <LineRow
            key={index}
            number={numbers?.[index] ?? null}
            gutter={gutter}
            onOpenLine={openLine}
            openLabel={file ? `Open ${basename(file.displayPath)}` : undefined}
            tabStop={index === 0}
          >
            {renderLine(index)}
          </LineRow>
        ))
      }
    </CodeLines>
  );
}

/** A file name above its lines; a button when the file can be opened. */
function FileHeader(props: {
  displayPath: string;
  /** `path:line` to open, or null when the file cannot be opened. */
  openTarget: string | null;
  openFile: (path: string) => void;
}) {
  const { displayPath, openTarget } = props;
  if (displayPath.length === 0) return null;
  if (!openTarget) {
    return (
      <p className="mt-1 mb-0.5 max-w-full select-none truncate text-2xs text-muted-foreground first:mt-0">
        {displayPath}
      </p>
    );
  }
  return (
    <button
      type="button"
      className="mt-1 mb-0.5 block max-w-full select-none truncate rounded-sm text-left text-2xs text-muted-foreground outline-none first:mt-0 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open ${displayPath}`}
      onClick={() => props.openFile(openTarget)}
    >
      {displayPath}
    </button>
  );
}

function SearchGroup(props: {
  segment: Extract<SearchSegment, { type: "group" }>;
  /** The first openable group holds the block's line-button tab stop. */
  firstGroup: boolean;
  gutter: string;
  theme: Theme;
  highlight: boolean;
  openFile: (path: string) => void;
}) {
  const { segment } = props;
  const code = useMemo(() => segment.lines.map((line) => line.text).join("\n"), [segment.lines]);
  // No file to open without a path (`grep -h`) or a known directory.
  const { filePath } = segment;
  const openLine = filePath ? (line: number) => props.openFile(`${filePath}:${line}`) : null;
  return (
    <div data-testid="command-output-search-group">
      {segment.showHeader && (
        <FileHeader
          displayPath={segment.displayPath}
          openTarget={filePath ? `${filePath}:${segment.lines[0]?.lineNumber ?? 1}` : null}
          openFile={props.openFile}
        />
      )}
      <CodeLines
        code={code}
        language={segment.language}
        theme={props.theme}
        highlight={props.highlight}
      >
        {(renderLine) =>
          segment.lines.map((line, index) => (
            <LineRow
              key={index}
              number={line.lineNumber}
              gutter={props.gutter}
              onOpenLine={openLine}
              openLabel={`Open ${basename(segment.displayPath)}`}
              tabStop={props.firstGroup && index === 0}
              className={line.isMatch ? undefined : "opacity-60"}
            >
              {renderLine(index, line.matches)}
            </LineRow>
          ))
        }
      </CodeLines>
    </div>
  );
}

function SearchOutput(props: {
  segments: ReadonlyArray<SearchSegment>;
  theme: Theme;
  highlight: boolean;
  openFile: (path: string) => void;
  /** False when an earlier section already holds the line-button tab stop. */
  tabStop?: boolean | undefined;
}) {
  const { segments } = props;
  const firstOpenableGroup =
    props.tabStop === false
      ? -1
      : segments.findIndex((segment) => segment.type === "group" && segment.filePath !== null);
  const gutter = useMemo(() => {
    let max = 1;
    for (const segment of segments) {
      if (segment.type !== "group") continue;
      for (const line of segment.lines) max = Math.max(max, line.lineNumber);
    }
    return gutterWidth(max);
  }, [segments]);
  return segments.map((segment, index) => {
    if (segment.type === "separator") {
      return (
        <div key={index} aria-hidden className="my-1 border-t border-dashed border-border/70" />
      );
    }
    if (segment.type === "plain") {
      return (
        <div key={index} className="whitespace-pre-wrap break-words">
          {segment.text}
        </div>
      );
    }
    return (
      <SearchGroup
        key={index}
        segment={segment}
        firstGroup={index === firstOpenableGroup}
        gutter={gutter}
        theme={props.theme}
        highlight={props.highlight}
        openFile={props.openFile}
      />
    );
  });
}

function FileSectionOutput(props: {
  section: Extract<OutputSection, { type: "file" }>;
  theme: Theme;
  highlight: boolean;
  openFile: (path: string) => void;
  tabStop: boolean;
}) {
  const { section } = props;
  const lineCount = useMemo(() => section.code.split("\n").length, [section.code]);
  const numbers = section.lineNumbers;
  const gutter = numbers && numbers.length > 0 ? gutterWidth(Math.max(...numbers)) : null;
  const { filePath } = section;
  const openLine = filePath ? (line: number) => props.openFile(`${filePath}:${line}`) : null;
  return (
    <div data-testid="command-output-file-section" className="mt-1 first:mt-0">
      <FileHeader
        displayPath={section.displayPath}
        openTarget={filePath ? `${filePath}${numbers?.[0] ? `:${numbers[0]}` : ""}` : null}
        openFile={props.openFile}
      />
      <CodeLines
        code={section.code}
        language={section.language}
        theme={props.theme}
        highlight={props.highlight}
      >
        {(renderLine) =>
          Array.from({ length: lineCount }, (_, index) => (
            <LineRow
              key={index}
              number={numbers?.[index] ?? null}
              gutter={gutter}
              onOpenLine={openLine}
              openLabel={`Open ${basename(section.displayPath)}`}
              tabStop={props.tabStop && index === 0}
            >
              {renderLine(index)}
            </LineRow>
          ))
        }
      </CodeLines>
    </div>
  );
}

/** A compound command's output, one statement's section after another. */
function SectionsOutput(props: {
  presentation: Extract<CommandOutputPresentation, { kind: "sections" }>;
  theme: Theme;
  highlight: boolean;
  openFile: (path: string) => void;
}) {
  const { sections } = props.presentation;
  // One tab stop for the whole block, on the first section with line buttons.
  const firstButtons = sections.findIndex((section) =>
    section.type === "file"
      ? section.filePath !== null && section.lineNumbers !== null
      : section.type === "search" &&
        section.segments.some((segment) => segment.type === "group" && segment.filePath !== null),
  );
  return sections.map((section, index) => {
    if (section.type === "plain") {
      return (
        <div key={index} className="mt-1 whitespace-pre-wrap break-words first:mt-0">
          {section.text}
        </div>
      );
    }
    if (section.type === "search") {
      return (
        <div key={index} className="mt-1 first:mt-0">
          <SearchOutput
            segments={section.segments}
            theme={props.theme}
            highlight={props.highlight}
            openFile={props.openFile}
            tabStop={index === firstButtons}
          />
        </div>
      );
    }
    return (
      <FileSectionOutput
        key={index}
        section={section}
        theme={props.theme}
        highlight={props.highlight}
        openFile={props.openFile}
        tabStop={index === firstButtons}
      />
    );
  });
}

const DIFF_ROW_CLASS_NAMES = {
  add: "bg-success/12",
  del: "bg-destructive/12",
  context: "",
  hunk: "text-info-foreground/80",
  meta: "text-muted-foreground",
} as const;

function DiffSection(props: {
  section: DiffFileSection;
  gutter: string | null;
  theme: Theme;
  highlight: boolean;
}) {
  const { section } = props;
  // Only content rows are highlighted, without their +/-/space prefix.
  const { code, codeIndexByRow } = useMemo(() => {
    const codeLines: string[] = [];
    const indexes = section.rows.map((row) => {
      if (row.kind !== "add" && row.kind !== "del" && row.kind !== "context") return -1;
      codeLines.push(row.text.slice(1));
      return codeLines.length - 1;
    });
    return { code: codeLines.join("\n"), codeIndexByRow: indexes };
  }, [section.rows]);
  return (
    <CodeLines
      code={code}
      language={section.language}
      theme={props.theme}
      highlight={props.highlight}
    >
      {(renderLine) =>
        section.rows.map((row, index) => {
          const codeIndex = codeIndexByRow[index] ?? -1;
          return (
            <LineRow
              key={index}
              number={row.lineNumber}
              gutter={props.gutter}
              className={DIFF_ROW_CLASS_NAMES[row.kind]}
            >
              {codeIndex >= 0 ? (
                <>
                  {row.text.slice(0, 1)}
                  {renderLine(codeIndex)}
                </>
              ) : (
                row.text
              )}
            </LineRow>
          );
        })
      }
    </CodeLines>
  );
}

function DiffOutput(props: {
  presentation: Extract<CommandOutputPresentation, { kind: "diff" }>;
  theme: Theme;
  highlight: boolean;
}) {
  const { files, showLineNumbers } = props.presentation;
  const gutter = useMemo(() => {
    if (!showLineNumbers) return null;
    let max = 1;
    for (const file of files) {
      for (const row of file.rows) max = Math.max(max, row.lineNumber ?? 0);
    }
    return gutterWidth(max);
  }, [files, showLineNumbers]);
  return files.map((section, index) => (
    <DiffSection
      key={index}
      section={section}
      gutter={gutter}
      theme={props.theme}
      highlight={props.highlight}
    />
  ));
}

const ANSI_FG_CLASS_NAMES = [
  "text-muted-foreground",
  "text-destructive-foreground",
  "text-success-foreground",
  "text-warning-foreground",
  "text-info-foreground",
  "text-attention-foreground",
  "text-info-foreground",
  "text-foreground",
] as const;
const ANSI_BG_CLASS_NAMES = [
  "bg-muted",
  "bg-destructive/25",
  "bg-success/25",
  "bg-warning/25",
  "bg-info/25",
  "bg-attention/25",
  "bg-info/25",
  "bg-foreground/15",
] as const;

function ansiColorClass(color: AnsiColor | undefined, classes: ReadonlyArray<string>) {
  return color?.kind === "palette" ? classes[color.index % 8] : undefined;
}

function ansiSpanProps(style: AnsiStyle): { className: string; style: CSSProperties } {
  return {
    className: cn(
      ansiColorClass(style.fg, ANSI_FG_CLASS_NAMES),
      // Bright black is the conventional "gray"; keep it muted, not foreground.
      style.fg?.kind === "palette" && style.fg.index === 8 && "text-muted-foreground",
      ansiColorClass(style.bg, ANSI_BG_CLASS_NAMES),
      style.bold && "font-semibold",
      style.dim && "opacity-70",
      style.italic && "italic",
      style.underline && "underline",
    ),
    style: {
      ...(style.fg?.kind === "rgb" ? { color: style.fg.value } : {}),
      ...(style.bg?.kind === "rgb" ? { backgroundColor: style.bg.value } : {}),
    },
  };
}

function AnsiLine({ spans }: { spans: ReadonlyArray<AnsiSpan> }) {
  let offset = 0;
  return spans.map((span) => {
    const key = offset;
    offset += span.text.length;
    if (!span.style) return <span key={key}>{span.text}</span>;
    const { className, style } = ansiSpanProps(span.style);
    return (
      <span key={key} className={className} style={style}>
        {span.text}
      </span>
    );
  });
}

function AnsiOutput(props: { presentation: Extract<CommandOutputPresentation, { kind: "ansi" }> }) {
  return props.presentation.lines.map((spans, index) => (
    <LineRow key={index}>
      <AnsiLine spans={spans} />
    </LineRow>
  ));
}

/** Marks counts that cover only the shown part of shortened output. */
function PartialLabel() {
  return (
    <span
      className="text-muted-foreground"
      title="Counts cover only the shown part of the output; lines in the middle were left out."
    >
      · partial
    </span>
  );
}

function OutputChip(props: {
  presentation: CommandOutputPresentation;
  openFile: (path: string) => void;
}) {
  const { presentation } = props;
  if (presentation.kind === "file") {
    const numbers = presentation.lineNumbers;
    const first = numbers?.[0];
    const last = numbers?.[numbers.length - 1];
    const details = [
      first !== undefined && last !== undefined
        ? first === last
          ? `line ${first}`
          : `lines ${first}–${last}`
        : null,
      presentation.language !== "text" ? presentation.language : null,
    ].filter((detail): detail is string => detail !== null);
    const { file } = presentation;
    const openPath = file?.filePath ?? null;
    if (!file || !openPath) {
      return (
        <span data-testid="command-output-chip" className={CHIP_CLASS_NAME}>
          <span className="truncate">
            {file ? basename(file.displayPath) : pluralize(presentation.fileCount, "file")}
          </span>
          {details.length > 0 && (
            <span className="shrink-0 text-muted-foreground">{details.join(" · ")}</span>
          )}
        </span>
      );
    }
    return (
      <button
        type="button"
        data-testid="command-output-chip"
        className={cn(
          CHIP_CLASS_NAME,
          "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        )}
        title={`Open ${file.displayPath}`}
        onClick={() => props.openFile(`${openPath}${first ? `:${first}` : ""}`)}
      >
        <span className="truncate">{basename(file.displayPath)}</span>
        {details.length > 0 && (
          <span className="shrink-0 text-muted-foreground">{details.join(" · ")}</span>
        )}
      </button>
    );
  }
  if (presentation.kind === "sections") {
    const files = presentation.sections.filter((section) => section.type === "file");
    const [onlyFile] = files;
    const fileLabel =
      files.length === 1 && onlyFile
        ? basename(onlyFile.displayPath)
        : files.length > 1
          ? pluralize(files.length, "file")
          : null;
    return (
      <span data-testid="command-output-chip" className={CHIP_CLASS_NAME}>
        {fileLabel && <span className="truncate">{fileLabel}</span>}
        {presentation.matchCount > 0 && (
          <span className={fileLabel ? "shrink-0 text-muted-foreground" : undefined}>
            {pluralize(presentation.matchCount, "match", "matches")}
          </span>
        )}
      </span>
    );
  }
  if (presentation.kind === "search") {
    return (
      <span data-testid="command-output-chip" className={CHIP_CLASS_NAME}>
        {pluralize(presentation.matchCount, "match", "matches")}
        {presentation.fileCount > 0 && (
          <span className="text-muted-foreground">
            in {pluralize(presentation.fileCount, "file")}
          </span>
        )}
        {presentation.partial && <PartialLabel />}
      </span>
    );
  }
  if (presentation.kind === "diff") {
    const fileCount = presentation.files.filter((file) => file.displayPath !== null).length;
    return (
      <span data-testid="command-output-chip" className={CHIP_CLASS_NAME}>
        {fileCount > 0 && <span>{pluralize(fileCount, "file")}</span>}
        <span className="text-success-foreground">+{presentation.additions}</span>
        <span className="text-destructive-foreground">−{presentation.deletions}</span>
        {presentation.partial && <PartialLabel />}
      </span>
    );
  }
  if (presentation.kind === "json") {
    return (
      <span data-testid="command-output-chip" className={CHIP_CLASS_NAME}>
        JSON
      </span>
    );
  }
  return null;
}

function searchSegmentsText(segments: ReadonlyArray<SearchSegment>): string {
  return segments
    .map((segment) =>
      segment.type === "group"
        ? segment.lines.map((line) => line.text).join("\n")
        : segment.type === "plain"
          ? segment.text
          : "",
    )
    .join("\n");
}

function presentationText(presentation: CommandOutputPresentation): string {
  switch (presentation.kind) {
    case "file":
      return presentation.code;
    case "plain":
    case "json":
    case "ansi":
      return presentation.text;
    case "search":
      return searchSegmentsText(presentation.segments);
    case "sections":
      return presentation.sections
        .map((section) =>
          section.type === "file"
            ? section.code
            : section.type === "search"
              ? searchSegmentsText(section.segments)
              : section.text,
        )
        .join("\n");
    case "diff":
      return presentation.files
        .map((file) => file.rows.map((row) => row.text).join("\n"))
        .join("\n");
  }
}

function OutputBody(props: {
  presentation: CommandOutputPresentation;
  theme: Theme;
  openFile: (path: string) => void;
}) {
  const { presentation, theme } = props;
  const highlight = useMemo(
    () => classifyCodeHighlight(presentationText(presentation)) === "inline",
    [presentation],
  );
  switch (presentation.kind) {
    case "plain":
      return <pre className="whitespace-pre-wrap break-words">{presentation.text}</pre>;
    case "ansi":
      return <AnsiOutput presentation={presentation} />;
    case "json":
      return (
        <CodeLines
          code={presentation.text.replace(/\r?\n$/, "")}
          language="json"
          theme={theme}
          highlight={highlight}
        >
          {(renderLine) =>
            presentation.text
              .replace(/\r?\n$/, "")
              .split(/\r?\n/)
              .map((_, index) => <LineRow key={index}>{renderLine(index)}</LineRow>)
          }
        </CodeLines>
      );
    case "file":
      return (
        <FileOutput
          presentation={presentation}
          theme={theme}
          highlight={highlight}
          openFile={props.openFile}
        />
      );
    case "search":
      return (
        <SearchOutput
          segments={presentation.segments}
          theme={theme}
          highlight={highlight}
          openFile={props.openFile}
        />
      );
    case "sections":
      return (
        <SectionsOutput
          presentation={presentation}
          theme={theme}
          highlight={highlight}
          openFile={props.openFile}
        />
      );
    case "diff":
      return <DiffOutput presentation={presentation} theme={theme} highlight={highlight} />;
  }
}

export interface CommandOutputBlockProps extends ClassifyCommandOutputInput {
  workspaceRoot: string | undefined;
  /** Renders the section header; `chip` describes the output, or is null. */
  renderHeader: (chip: ReactNode) => ReactNode;
}

/**
 * A command's output, presented by what it contains: file content with line
 * numbers, grouped search results, a tinted diff, JSON, or ANSI colors.
 * Anything else is the plain text the card always showed.
 */
export function CommandOutputBlock(props: CommandOutputBlockProps) {
  const { resolvedTheme } = useTheme();
  const { command, output, status, cwd, exitCode, shortened } = props;
  const presentation = useMemo(
    () => classifyCommandOutput({ command, output, status, cwd, exitCode, shortened }),
    [command, output, status, cwd, exitCode, shortened],
  );
  const openFile = useOpenWorkspaceFile({ workspaceRoot: props.workspaceRoot });
  return (
    <div data-output-kind={presentation.kind}>
      {props.renderHeader(<OutputChip presentation={presentation} openFile={openFile} />)}
      <div className="mt-1 max-h-80 overflow-auto rounded-md bg-background/70 p-2">
        <div
          data-testid="command-output-body"
          className={OUTPUT_TEXT_CLASS_NAME}
          onKeyDown={handleGutterKeyDown}
        >
          <OutputBody presentation={presentation} theme={resolvedTheme} openFile={openFile} />
        </div>
      </div>
    </div>
  );
}
