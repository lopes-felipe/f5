/** Assign the actual runtime builders to fixed-version generated request types. */
export function codexRequestShapeProbe(
  builderPath: string,
  schemaPath: string,
  available: ReadonlySet<string>,
): string {
  const methods = [
    ["thread/goal/set", "v2/ThreadGoalSetParams", 'buildCodexGoalPauseParams("thread", "user")'],
    ["thread/goal/clear", "v2/ThreadGoalClearParams", 'buildCodexGoalClearParams("thread")'],
    [
      "thread/sample",
      "v2/ThreadSampleParams",
      'buildCodexSampleParams("thread", "turn", "question")',
    ],
    [
      "thread/readState/update",
      "v2/ThreadReadStateUpdateParams",
      'buildCodexReadMarkParams("thread", "revision")',
    ],
    ["thread/memory/read", "v2/ThreadMemoryReadParams", 'buildCodexMemoryReadParams("thread")'],
    ["initialize", "InitializeParams", "buildCodexInitializeParams()"],
    [
      "thread/start",
      "v2/ThreadStartParams",
      'buildCodexThreadOpenRequestParams({ runtimeMode: "full-access", cwd: "/tmp", model: "gpt-5.3-codex", resumeThreadId: "thread" }).start',
    ],
    [
      "thread/resume",
      "v2/ThreadResumeParams",
      'buildCodexThreadOpenRequestParams({ runtimeMode: "approval-required", resumeThreadId: "thread" }).resume!',
    ],
    ["thread/revert", "v2/ThreadRevertParams", 'buildCodexThreadRevertParams("thread", "turn")'],
    [
      "thread/fork",
      "v2/ThreadForkParams",
      'buildCodexThreadForkParams({ runtimeMode: "auto-accept-edits", cwd: "/tmp" }, "thread", "turn")',
    ],
    [
      "turn/start",
      "v2/TurnStartParams",
      'buildCodexTurnStartParams({ threadId: ThreadId.makeUnsafe("f5"), input: "hello", effort: "high" }, { providerThreadId: "thread", account: { type: "unknown", planType: null, sparkEnabled: false } })',
    ],
    [
      "turn/steer",
      "v2/TurnSteerParams",
      'buildCodexTurnSteerParams("thread", [{ type: "text", text: "hello", text_elements: [] }], "turn")',
    ],
  ] as const;
  const lines = [
    `import { buildCodexInitializeParams, buildCodexThreadOpenRequestParams, buildCodexThreadRevertParams, buildCodexThreadForkParams, buildCodexTurnStartParams, buildCodexTurnSteerParams } from ${JSON.stringify(builderPath)};`,
    'import { ThreadId } from "@t3tools/contracts";',
    `import { buildCodexSampleParams, buildCodexReadMarkParams, buildCodexMemoryReadParams, buildCodexGoalPauseParams, buildCodexGoalClearParams } from ${JSON.stringify(builderPath)};`,
  ];
  for (const [method, file, expression] of methods) {
    if (!available.has(method)) continue;
    const type = file.split("/").at(-1)!;
    lines.push(`import type { ${type} } from ${JSON.stringify(`${schemaPath}/${file}.ts`)};`);
    lines.push(`const ${type}Check: ${type} = ${expression}; void ${type}Check;`);
  }
  return lines.join("\n");
}
