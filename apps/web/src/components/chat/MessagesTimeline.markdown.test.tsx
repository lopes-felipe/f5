import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageId, TurnId } from "@t3tools/contracts";

import { deriveTimelineEntries } from "../../session-logic";

function LegendListStub<T>(props: {
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor: (item: T, index: number) => string;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  className?: string;
}) {
  const { data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, className } =
    props;
  return (
    <div className={className}>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={keyExtractor(item, 0)}>{renderItem({ item, index })}</div>
      ))}
      {ListFooterComponent}
    </div>
  );
}

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml: (code: string) => `<pre data-shiki-stub="true">${code}</pre>`,
    }),
  SupportedLanguages: {},
  // eslint-disable-next-line typescript-eslint/no-extraneous-class
  DiffsHighlighter: class DiffsHighlighterStub {},
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: LegendListStub,
}));

vi.mock("../../appSettings", () => ({
  useAppSettings: () => ({
    settings: {
      expandMcpToolCalls: false,
      expandMcpToolCallCardsByDefault: true,
      showReasoningExpanded: false,
      showFileChangeDiffsInline: false,
    },
  }),
}));

vi.mock("../../fileNavigationContext", () => ({
  useFileNavigation: () => () => false,
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light" as const,
    resolvedTheme: "light" as const,
    setTheme: () => {},
  }),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => null,
}));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("./VscodeEntryIcon", () => ({
  VscodeEntryIcon: () => null,
}));

describe("MessagesTimeline markdown streaming", () => {
  it("keeps earlier assistant markdown formatted while an open fence stays cheap", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessage = {
      id: MessageId.makeUnsafe("assistant-message-1"),
      role: "assistant" as const,
      text: [
        "Intro with **bold text** and a list:",
        "",
        "- first",
        "- second",
        "",
        "```ts",
        "const x = 1;",
      ].join("\n"),
      turnId: TurnId.makeUnsafe("turn-1"),
      createdAt: "2026-04-23T18:00:00.000Z",
      streaming: true,
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={{ current: null }}
        onIsAtEndChange={() => {}}
        timelineEntries={deriveTimelineEntries([assistantMessage], [], [])}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnDiffSummaryByTurnId={new Map()}
        nowIso="2026-04-23T18:00:10.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd="/tmp/project"
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/tmp/project"
        expandedCommandExecutions={{}}
        onToggleCommandExecution={() => {}}
        allDirectoriesExpanded
        onToggleAllDirectories={() => {}}
      />,
    );

    expect(markup).toContain("<strong>bold text</strong>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<li>first</li>");
    expect(markup).toContain("```ts");
    expect(markup).toContain("const x = 1;");
    expect(markup).not.toContain("chat-markdown-codeblock");
  });
});
