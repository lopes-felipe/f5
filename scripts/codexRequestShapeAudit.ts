/** Assign the actual runtime builders to fixed-version generated request types. */
export function codexRequestShapeProbe(
  builderPath: string,
  schemaPath: string,
  available: ReadonlySet<string>,
): string {
  const methods = [
    ["account/usage/read", "v2/GetAccountTokenUsageParams", 'buildCodexUsageReadParams("thread")'],
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
    ["initialize", "InitializeParams", 'buildCodexInitializeParams("0.170.0")'],
    ["modelProvider/list", "v2/ModelProviderListParams", "{}"],
    [
      "modelProvider/config/write",
      "v2/ModelProviderConfigWriteParams",
      'buildCodexProviderWriteParams({ type: "customGateway", name: "Gateway", baseUrl: "https://example.test" })',
    ],
    [
      "account/gatewayOAuth/read",
      "v2/GatewayOAuthReadParams",
      'buildCodexGatewayReadParams("gateway")',
    ],
    [
      "account/gatewayOAuth/login",
      "v2/GatewayOAuthLoginParams",
      'buildCodexGatewayLoginParams("gateway", true)',
    ],
    [
      "mcpServer/resource/read",
      "v2/McpResourceReadParams",
      'buildCodexResourceReadParams("thread", "server", "ui://app", { originCallId: "call", target: { connectorId: "app", linkId: null } })',
    ],
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
    `import { buildCodexGatewayLoginParams, buildCodexGatewayReadParams, buildCodexProviderWriteParams, buildCodexResourceReadParams } from ${JSON.stringify(builderPath.replace(/codexAppServerManager\.ts$/, "codex/codexConfigurationRequests.ts"))};`,
    "type ExtraKeys<Actual, Expected> = Exclude<keyof Actual, keyof Expected>;",
    "const exact = <Expected>() => <Actual extends Expected>(value: Actual & Record<ExtraKeys<Actual, Expected>, never>): Expected => value;",
    `import { buildCodexInitializeParams, buildCodexThreadOpenRequestParams, buildCodexThreadRevertParams, buildCodexThreadForkParams, buildCodexTurnStartParams, buildCodexTurnSteerParams } from ${JSON.stringify(builderPath)};`,
    'import { ThreadId } from "@t3tools/contracts";',
    `import { buildCodexSampleParams, buildCodexReadMarkParams, buildCodexMemoryReadParams, buildCodexUsageReadParams, buildCodexGoalPauseParams, buildCodexGoalClearParams } from ${JSON.stringify(builderPath)};`,
  ];
  for (const [method, file, expression] of methods) {
    if (!available.has(method)) continue;
    const type = file.split("/").at(-1)!;
    lines.push(`import type { ${type} } from ${JSON.stringify(`${schemaPath}/${file}.ts`)};`);
    lines.push(`const ${type}Check = exact<${type}>()(${expression}); void ${type}Check;`);
  }
  return lines.join("\n");
}
