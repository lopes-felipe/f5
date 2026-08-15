import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { AGENTS_WS_CHANNELS, AGENTS_WS_METHODS } from "./backgroundWork";
import { ServerValidateHarnessesResult } from "./server";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownEffect(WebSocketRequest);
const decodeWsResponse = Schema.decodeUnknownEffect(WsResponse);
const decodeServerValidateHarnessesResult = Schema.decodeUnknownEffect(
  ServerValidateHarnessesResult,
);

it.effect("accepts lightweight server probe requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "probe-1",
      body: { _tag: WS_METHODS.serverProbe },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverProbe);
  }),
);

it.effect("accepts agents snapshots and validates their update payloads", () =>
  Effect.gen(function* () {
    const request = yield* decodeWebSocketRequest({
      id: "agents-1",
      body: { _tag: AGENTS_WS_METHODS.getSnapshot },
    });
    assert.strictEqual(request.body._tag, AGENTS_WS_METHODS.getSnapshot);

    const push = yield* decodeWsResponse({
      type: "push",
      sequence: 1,
      channel: AGENTS_WS_CHANNELS.snapshotUpdated,
      data: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            threadId: "thread-1",
            workItemId: "task-1",
            provider: "claudeAgent",
            providerInstanceId: null,
            providerSessionIdentity: null,
            turnId: null,
            classification: "working",
            ownership: "direct-subagent",
            status: "running",
            active: true,
            model: null,
            phase: null,
            latestOutput: null,
            outputTruncated: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
          },
        ],
      },
    });
    assert.strictEqual("channel" in push ? push.channel : null, AGENTS_WS_CHANNELS.snapshotUpdated);

    const invalid = yield* Effect.exit(
      decodeWsResponse({
        type: "push",
        sequence: 2,
        channel: AGENTS_WS_CHANNELS.snapshotUpdated,
        data: {
          generatedAt: "2026-01-01T00:00:00.000Z",
          entries: [{ classification: "unknown" }],
        },
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("accepts project content search and cancellation requests", () =>
  Effect.gen(function* () {
    const search = yield* decodeWebSocketRequest({
      id: "content-search",
      body: {
        _tag: WS_METHODS.projectsSearchContents,
        requestId: "request-1",
        projectId: "project-1",
        query: "needle",
        limit: 500,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      },
    });
    assert.strictEqual(search.body._tag, WS_METHODS.projectsSearchContents);

    const cancel = yield* decodeWebSocketRequest({
      id: "content-cancel",
      body: {
        _tag: WS_METHODS.projectsCancelContentSearch,
        requestId: "request-1",
      },
    });
    assert.strictEqual(cancel.body._tag, WS_METHODS.projectsCancelContentSearch);
  }),
);

it.effect("accepts checked-in project configuration requests", () =>
  Effect.gen(function* () {
    const request = yield* decodeWebSocketRequest({
      id: "project-config",
      body: {
        _tag: WS_METHODS.projectsGetCheckedInConfig,
        projectId: "project-1",
      },
    });
    assert.strictEqual(request.body._tag, WS_METHODS.projectsGetCheckedInConfig);
  }),
);

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWebSocketRequest({
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
        expectedHeadOid: "abc123",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("decodes every built-in workflow platform create-run request", () =>
  Effect.gen(function* () {
    const codex = { provider: "codex", model: "gpt-5.1-codex" };
    const claude = { provider: "claudeAgent", model: "claude-sonnet-4-6" };
    const requests = [
      {
        id: "req-workflow-planning",
        body: {
          _tag: WS_METHODS.workflowPlatformCreateRun,
          templateId: "builtin.planning.dual",
          templateVersion: 1,
          input: {
            projectId: "project-1",
            requirementPrompt: "Plan reconnect recovery",
            selfReviewEnabled: true,
            branchA: codex,
            branchB: claude,
            merge: codex,
          },
        },
      },
      {
        id: "req-workflow-review",
        body: {
          _tag: WS_METHODS.workflowPlatformCreateRun,
          templateId: "builtin.code-review.dual",
          templateVersion: 1,
          input: {
            projectId: "project-1",
            reviewPrompt: "Review reconnect recovery",
            reviewerA: codex,
            reviewerB: claude,
            consolidation: codex,
          },
        },
      },
      {
        id: "req-workflow-investigation",
        body: {
          _tag: WS_METHODS.workflowPlatformCreateRun,
          templateId: "builtin.investigation.dual",
          templateVersion: 1,
          input: {
            projectId: "project-1",
            problemPrompt: "Investigate reconnect recovery",
            investigatorA: codex,
            investigatorB: claude,
            synthesis: codex,
          },
        },
      },
    ] as const;

    for (const request of requests) {
      const parsed = yield* decodeWebSocketRequest(request);
      assert.strictEqual(parsed.body._tag, WS_METHODS.workflowPlatformCreateRun);
      if (parsed.body._tag === WS_METHODS.workflowPlatformCreateRun) {
        assert.strictEqual(parsed.body.templateId, request.body.templateId);
      }
    }
  }),
);

it.effect("accepts server.validateHarnesses requests without provider options", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-harness-1",
      body: {
        _tag: WS_METHODS.serverValidateHarnesses,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverValidateHarnesses);
  }),
);

it.effect("accepts preview session requests", () =>
  Effect.gen(function* () {
    const open = yield* decodeWebSocketRequest({
      id: "req-preview-open",
      body: {
        _tag: WS_METHODS.previewOpen,
        threadId: "thread-preview",
        url: "localhost:5173",
      },
    });
    assert.strictEqual(open.body._tag, WS_METHODS.previewOpen);

    const report = yield* decodeWebSocketRequest({
      id: "req-preview-report",
      body: {
        _tag: WS_METHODS.previewReportStatus,
        threadId: "thread-preview",
        tabId: "tab_1",
        navStatus: {
          _tag: "Success",
          url: "http://localhost:5173/",
          title: "Dev",
        },
        canGoBack: false,
        canGoForward: false,
      },
    });
    assert.strictEqual(report.body._tag, WS_METHODS.previewReportStatus);
  }),
);

it.effect("accepts preview push events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.previewEvent,
      data: {
        type: "opened",
        threadId: "thread-preview",
        tabId: "tab_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        snapshot: {
          threadId: "thread-preview",
          tabId: "tab_1",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    assert.ok("type" in parsed);
    if ("type" in parsed) {
      assert.strictEqual(parsed.type, "push");
      assert.strictEqual(parsed.channel, WS_CHANNELS.previewEvent);
    }
  }),
);

it.effect("accepts exact keybinding mutation requests", () =>
  Effect.gen(function* () {
    const add = yield* decodeWebSocketRequest({
      id: "req-keybinding-add",
      body: {
        _tag: WS_METHODS.serverAddKeybinding,
        rule: { key: "mod+t", command: "terminal.toggle" },
      },
    });
    assert.strictEqual(add.body._tag, WS_METHODS.serverAddKeybinding);

    const update = yield* decodeWebSocketRequest({
      id: "req-keybinding-update",
      body: {
        _tag: WS_METHODS.serverUpdateKeybinding,
        target: { key: "mod+t", command: "terminal.toggle" },
        rule: { key: "mod+shift+t", command: "terminal.toggle", when: "!terminalFocus" },
      },
    });
    assert.strictEqual(update.body._tag, WS_METHODS.serverUpdateKeybinding);

    const remove = yield* decodeWebSocketRequest({
      id: "req-keybinding-remove",
      body: {
        _tag: WS_METHODS.serverRemoveKeybinding,
        target: { key: "mod+shift+t", command: "terminal.toggle", when: "!terminalFocus" },
      },
    });
    assert.strictEqual(remove.body._tag, WS_METHODS.serverRemoveKeybinding);

    const reset = yield* decodeWebSocketRequest({
      id: "req-keybinding-reset",
      body: {
        _tag: WS_METHODS.serverResetKeybindings,
      },
    });
    assert.strictEqual(reset.body._tag, WS_METHODS.serverResetKeybindings);
  }),
);

it.effect("accepts server.validateHarnesses results", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeServerValidateHarnessesResult({
      results: [
        {
          provider: "codex",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-23T12:00:00.000Z",
          version: "1.2.3",
        },
        {
          provider: "claudeAgent",
          status: "error",
          installed: false,
          authStatus: "unknown",
          failureKind: "notInstalled",
          checkedAt: "2026-04-23T12:00:00.000Z",
          message: "Claude Code is not installed.",
        },
      ],
    });

    assert.strictEqual(parsed.results.length, 2);
    assert.strictEqual(parsed.results[0]?.provider, "codex");
    assert.strictEqual(parsed.results[1]?.failureKind, "notInstalled");
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWsResponse({
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts git status invalidation push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.gitStatusInvalidated,
      data: {
        cwd: "/tmp/worktree",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitStatusInvalidated);
    assert.deepStrictEqual(parsed.data, { cwd: "/tmp/worktree" });
  }),
);

it.effect("accepts provider advisory push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.providerAdvisoriesUpdated,
      data: {
        advisories: [
          {
            instanceId: "codex",
            driver: "codex",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "1.0.0",
              latestVersion: "1.1.0",
              updateCommand: {
                executable: "npm",
                args: ["install", "-g", "@openai/codex@latest"],
                channel: "npm",
              },
              checkedAt: "2026-05-26T00:00:00.000Z",
              message: "Installed v1.0.0 · latest v1.1.0",
            },
          },
        ],
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    if (parsed.channel !== WS_CHANNELS.providerAdvisoriesUpdated) {
      assert.fail("expected provider advisories channel");
    }
    assert.strictEqual(parsed.data.advisories[0]?.versionAdvisory.status, "behind_latest");
  }),
);

it.effect("rejects malformed provider advisory push envelopes", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWsResponse({
        type: "push",
        sequence: 5,
        channel: WS_CHANNELS.providerAdvisoriesUpdated,
        data: {
          advisories: [{ instanceId: "codex", driver: "codex" }],
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts global git status invalidation push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.gitStatusInvalidated,
      data: {
        cwd: null,
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitStatusInvalidated);
    assert.deepStrictEqual(parsed.data, { cwd: null });
  }),
);
