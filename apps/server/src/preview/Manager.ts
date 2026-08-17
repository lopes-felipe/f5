import {
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewRecentLocation,
  type PreviewReportStatusInput,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
} from "@t3tools/shared/preview";
import { DateTime, Effect } from "effect";

export interface PreviewManager {
  readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly navigate: (
    input: PreviewNavigateInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;
  readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
  readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
  readonly subscribe: (listener: (event: PreviewEvent) => void) => () => void;
}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

export const MAX_PREVIEW_RECENT_LOCATIONS = 20;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) =>
      new PreviewInvalidUrlError({
        rawUrl,
        detail:
          cause instanceof PreviewUrlNormalizationError
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : String(cause),
      }),
  });

const buildIdleSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId as PreviewSessionSnapshot["threadId"],
  tabId: input.tabId as PreviewSessionSnapshot["tabId"],
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  colorScheme: "system",
  viewport: null,
  viewportLinked: true,
  updatedAt: input.updatedAt,
});

const buildLoadingSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly colorScheme?: PreviewSessionSnapshot["colorScheme"];
  readonly viewport?: PreviewSessionSnapshot["viewport"];
  readonly viewportLinked?: PreviewSessionSnapshot["viewportLinked"];
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId as PreviewSessionSnapshot["threadId"],
  tabId: input.tabId as PreviewSessionSnapshot["tabId"],
  navStatus: { _tag: "Loading", url: input.url, title: input.title },
  canGoBack: input.canGoBack ?? false,
  canGoForward: input.canGoForward ?? false,
  colorScheme: input.colorScheme ?? "system",
  viewport: input.viewport ?? null,
  viewportLinked: input.viewportLinked ?? true,
  updatedAt: input.updatedAt,
});

export function makePreviewManager(): PreviewManager {
  const sessions = new Map<string, PreviewSessionState>();
  let recentLocations: PreviewRecentLocation[] = [];
  const listeners = new Set<(event: PreviewEvent) => void>();

  const rememberLocation = (location: PreviewRecentLocation): void => {
    recentLocations = [
      location,
      ...recentLocations.filter((candidate) => candidate.url !== location.url),
    ].slice(0, MAX_PREVIEW_RECENT_LOCATIONS);
  };

  const emit = (event: PreviewEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break the preview state transition.
      }
    }
  };

  const getExisting = (
    threadId: string,
    tabId: string,
  ): Effect.Effect<PreviewSessionState, PreviewSessionLookupError> =>
    Effect.sync(() => {
      const session = sessions.get(compositeKey(threadId, tabId));
      return session;
    }).pipe(
      Effect.flatMap((session) =>
        session
          ? Effect.succeed(session)
          : Effect.fail(new PreviewSessionLookupError({ threadId, tabId })),
      ),
    );

  const setSession = (session: PreviewSessionState): void => {
    sessions.set(compositeKey(session.threadId, session.tabId), session);
  };

  return {
    open: (input) =>
      Effect.gen(function* () {
        const tabId = newPreviewTabId();
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot = input.url
          ? buildLoadingSnapshot({
              threadId: input.threadId,
              tabId,
              url: yield* normalizeUrl(input.url),
              title: "",
              updatedAt,
            })
          : buildIdleSnapshot({ threadId: input.threadId, tabId, updatedAt });
        setSession({ threadId: input.threadId, tabId, snapshot });
        emit({
          type: "opened",
          threadId: input.threadId,
          tabId,
          createdAt: snapshot.updatedAt,
          snapshot,
        });
        return snapshot;
      }),

    navigate: (input) =>
      Effect.gen(function* () {
        const session = yield* getExisting(input.threadId, input.tabId);
        const updatedAt = yield* currentIsoTimestamp;
        const previousTitle =
          session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
        const snapshot = buildLoadingSnapshot({
          threadId: session.threadId,
          tabId: session.tabId,
          url: yield* normalizeUrl(input.url),
          title: input.resolvedTitle ?? previousTitle,
          canGoBack: session.snapshot.canGoBack,
          canGoForward: session.snapshot.canGoForward,
          colorScheme: session.snapshot.colorScheme,
          viewport: session.snapshot.viewport,
          viewportLinked: session.snapshot.viewportLinked,
          updatedAt,
        });
        const next = { ...session, snapshot };
        setSession(next);
        emit({
          type: "navigated",
          threadId: session.threadId as PreviewEvent["threadId"],
          tabId: session.tabId as PreviewEvent["tabId"],
          createdAt: snapshot.updatedAt,
          snapshot,
        });
        return snapshot;
      }),

    reportStatus: (input) =>
      Effect.gen(function* () {
        const session = yield* getExisting(input.threadId, input.tabId);
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          threadId: session.threadId as PreviewSessionSnapshot["threadId"],
          tabId: session.tabId as PreviewSessionSnapshot["tabId"],
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          colorScheme: input.colorScheme ?? session.snapshot.colorScheme,
          viewport: input.viewport === undefined ? session.snapshot.viewport : input.viewport,
          viewportLinked: input.viewportLinked ?? session.snapshot.viewportLinked,
          updatedAt,
        };
        if (input.navStatus._tag === "Success") {
          rememberLocation({
            url: input.navStatus.url,
            title: input.navStatus.title,
            visitedAt: updatedAt,
          });
        }
        setSession({ ...session, snapshot });
        if (input.navStatus._tag === "LoadFailed") {
          emit({
            type: "failed",
            threadId: session.threadId as PreviewEvent["threadId"],
            tabId: session.tabId as PreviewEvent["tabId"],
            createdAt: snapshot.updatedAt,
            url: input.navStatus.url,
            title: input.navStatus.title,
            code: input.navStatus.code,
            description: input.navStatus.description,
          });
          return;
        }
        emit({
          type: "navigated",
          threadId: session.threadId as PreviewEvent["threadId"],
          tabId: session.tabId as PreviewEvent["tabId"],
          createdAt: snapshot.updatedAt,
          snapshot,
        });
      }),

    refresh: (input) => getExisting(input.threadId, input.tabId).pipe(Effect.asVoid),

    close: (input) =>
      Effect.gen(function* () {
        const createdAt = yield* currentIsoTimestamp;
        const targets = input.tabId
          ? [sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : [...sessions.values()].filter((session) => session.threadId === input.threadId);
        for (const target of targets) {
          sessions.delete(compositeKey(target.threadId, target.tabId));
          emit({
            type: "closed",
            threadId: target.threadId as PreviewEvent["threadId"],
            tabId: target.tabId as PreviewEvent["tabId"],
            createdAt,
          });
        }
      }),

    list: (input) =>
      Effect.sync(
        (): PreviewListResult => ({
          sessions: [...sessions.values()]
            .filter((session) => session.threadId === input.threadId)
            .map((session) => session.snapshot)
            .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
          recentLocations,
        }),
      ),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
