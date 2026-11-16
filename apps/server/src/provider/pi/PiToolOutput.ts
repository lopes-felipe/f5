import {
  TOOL_COMPLETION_INLINE_INPUT_MAX_BYTES,
  TOOL_COMPLETION_INLINE_OUTPUT_MAX_BYTES,
  type ItemLifecyclePayload,
} from "@t3tools/contracts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { piRecordField, piRecordNumber, piRecordString } from "./PiProtocol.ts";

/** Native results are already scrubbed of images before this bounded projection runs. */
export function piToolPayload(input: {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly completed: boolean;
  readonly isError?: boolean;
}): ItemLifecyclePayload {
  const { name, result } = input;
  const shell = name === "bash" || name === "powershell";
  const file = name === "edit" || name === "write";
  const exitCode =
    piRecordNumber(piRecordField(result, "structuredContent"), "exit_code") ??
    piRecordNumber(piRecordField(result, "details"), "exitCode");
  const error =
    input.isError === true ||
    (shell && exitCode !== undefined && exitCode !== 0) ||
    piRecordField(piRecordField(result, "structuredContent"), "success") === false;
  const args = stringifyWithinBytes(input.args, TOOL_COMPLETION_INLINE_INPUT_MAX_BYTES);
  const output = stringifyWithinBytes(result, TOOL_COMPLETION_INLINE_OUTPUT_MAX_BYTES);
  const data = {
    toolName: name,
    ...(args === undefined ? {} : { input: JSON.parse(args) as unknown }),
    ...(output === undefined ? {} : { result: JSON.parse(output) as unknown }),
    ...(shell ? { command: (piRecordString(input.args, "command") ?? "").slice(0, 4096) } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(file
      ? {
          path: (
            piRecordString(input.args, "path") ??
            piRecordString(input.args, "file_path") ??
            ""
          ).slice(0, 4096),
        }
      : {}),
  };
  return {
    itemType: shell
      ? "command_execution"
      : file
        ? "file_change"
        : name.startsWith("mcp__")
          ? "mcp_tool_call"
          : "dynamic_tool_call",
    status: input.completed ? (error ? "failed" : "completed") : "inProgress",
    title: name,
    data,
    ...(input.completed
      ? {
          completion: {
            version: 1,
            nativeCallId: input.callId,
            toolName: name,
            ...(args === undefined
              ? { inputOmission: { reason: "too-large" as const } }
              : { input: data.input }),
            ...(output === undefined
              ? { outputOmission: { reason: "too-large" as const } }
              : { structuredOutput: data.result }),
            transportError: input.isError === true,
            semanticSuccess: !error,
          },
        }
      : {}),
  };
}
