import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLAUDE_SDK_MESSAGE_DISPOSITIONS } from "@t3tools/shared/claudeSdkManifest";
import {
  deprecatedClaudeSdkReferences,
  extractClaudeSdkMessageSurface,
  handledClaudeMessageCases,
  unclassifiedClaudeMessages,
} from "./claudeSdkAudit.ts";

const surface = (fixture: string) => {
  const file = path.join(import.meta.dirname, "fixtures/claude-sdk", fixture);
  const program = ts.createProgram([file], {});
  return extractClaudeSdkMessageSurface(program, program.getSourceFile(file)!);
};

describe("Claude SDK drift guardrail", () => {
  it("classifies the positive declaration fixture", () =>
    expect(
      unclassifiedClaudeMessages(surface("positive.d.ts"), CLAUDE_SDK_MESSAGE_DISPOSITIONS),
    ).toEqual([]));
  it("rejects new message types and system subtypes", () =>
    expect(
      unclassifiedClaudeMessages(surface("negative.d.ts"), CLAUDE_SDK_MESSAGE_DISPOSITIONS),
    ).toEqual(["future_message", "system/new_unclassified_subtype"]));
  it("covers every canonical and diagnostic manifest entry in explicit adapter cases", () => {
    const adapter = readFileSync(
      path.join(import.meta.dirname, "../apps/server/src/provider/Layers/ClaudeAdapter.ts"),
      "utf8",
    );
    const types = handledClaudeMessageCases(adapter, "handleSdkMessage");
    const subtypes = handledClaudeMessageCases(adapter, "handleSystemMessage");
    for (const [key, disposition] of Object.entries(CLAUDE_SDK_MESSAGE_DISPOSITIONS)) {
      if (disposition === "ignored") continue;
      expect(key.startsWith("system/") ? subtypes.has(key.slice(7)) : types.has(key), key).toBe(
        true,
      );
    }
  });
  it("reports references to deprecated SDK declarations through the TypeScript checker", () => {
    const declarations = "/virtual/node_modules/claude-agent-sdk/sdk.d.ts";
    const client = "/virtual/apps/server/src/provider/fixture.ts";
    const files: Record<string, string> = {
      [declarations]:
        "declare module 'claude-sdk-fixture' { export interface Query {\n/** @deprecated Use thinking */\nsetMaxThinkingTokens(value: number): void;\nsetModel(value: string): void; } }",
      [client]:
        "import type { Query } from 'claude-sdk-fixture'; declare const query: Query; query.setMaxThinkingTokens(1); query.setModel('model');",
    };
    const host = ts.createCompilerHost({ noLib: true });
    host.getSourceFile = (file, languageVersion) =>
      files[file] === undefined
        ? undefined
        : ts.createSourceFile(file, files[file]!, languageVersion, true);
    const program = ts.createProgram([client, declarations], { noLib: true }, host);
    expect(deprecatedClaudeSdkReferences(program)).toEqual([`${client}:1 setMaxThinkingTokens`]);
  });
});
