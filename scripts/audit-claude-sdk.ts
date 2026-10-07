import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  CLAUDE_SDK_BASELINE_VERSION,
  CLAUDE_SDK_MESSAGE_DISPOSITIONS,
} from "@t3tools/shared/claudeSdkManifest";
import {
  deprecatedClaudeSdkReferences,
  extractClaudeSdkMessageSurface,
  handledClaudeMessageCases,
  unclassifiedClaudeMessages,
} from "./claudeSdkAudit.ts";

const root = path.resolve(import.meta.dirname, "..");
const sdkDir = path.join(root, "apps/server/node_modules/@anthropic-ai/claude-agent-sdk");
const sdkFile = path.join(sdkDir, "sdk.d.ts");
const sdkPackage = JSON.parse(await readFile(path.join(sdkDir, "package.json"), "utf8")) as {
  version: string;
};
const config = ts.getParsedCommandLineOfConfigFile(
  path.join(root, "apps/server/tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  },
);
if (!config) throw new Error("Server TypeScript configuration unavailable");
const program = ts.createProgram([...config.fileNames, sdkFile], config.options);
const source = program.getSourceFile(sdkFile);
if (!source) throw new Error("Installed SDK declarations unavailable");
const surface = extractClaudeSdkMessageSurface(program, source);
const unclassified = unclassifiedClaudeMessages(surface, CLAUDE_SDK_MESSAGE_DISPOSITIONS);
const absent = Object.keys(CLAUDE_SDK_MESSAGE_DISPOSITIONS).filter((key) => !surface.includes(key));
console.log(
  `Claude SDK audit: ${sdkPackage.version}; pinned ${CLAUDE_SDK_BASELINE_VERSION}; ${surface.length} message discriminators`,
);
const adapter = await readFile(
  path.join(root, "apps/server/src/provider/Layers/ClaudeAdapter.ts"),
  "utf8",
);
const types = handledClaudeMessageCases(adapter, "handleSdkMessage");
const subtypes = handledClaudeMessageCases(adapter, "handleSystemMessage");
const uncovered = Object.entries(CLAUDE_SDK_MESSAGE_DISPOSITIONS)
  .filter(
    ([key, disposition]) =>
      disposition !== "ignored" &&
      !(key.startsWith("system/") ? subtypes.has(key.slice(7)) : types.has(key)),
  )
  .map(([key]) => key);
const deprecated = deprecatedClaudeSdkReferences(program);
for (const reference of deprecated)
  console.log(
    `Deprecated SDK reference (Release 1 thinking migration): ${path.relative(root, reference)}`,
  );
for (const key of unclassified) console.error(`Unclassified message: ${key}`);
for (const key of absent) console.error(`Manifest message absent from pinned SDK: ${key}`);
for (const key of uncovered) console.error(`Missing explicit adapter case: ${key}`);
if (
  sdkPackage.version !== CLAUDE_SDK_BASELINE_VERSION ||
  unclassified.length ||
  absent.length ||
  uncovered.length
)
  process.exitCode = 1;
else console.log("All SDK messages classified and adapter cases covered.");
