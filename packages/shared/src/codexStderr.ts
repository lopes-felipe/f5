const BENIGN_CODEX_PROCESS_STDERR_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
] as const;

const BENIGN_CODEX_TELEMETRY_EXPORT_ERROR_SNIPPETS = [
  'name="BatchSpanProcessor.Flush.ExportError"',
  'name="BatchSpanProcessor.ExportError"',
  'name="BatchSpanProcessor.Export.Error"',
] as const;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_SGR_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");

// Codex 0.147.0 cannot deserialize the shared model cache written by
// 0.148.0-alpha.21 after that version removed this field. Retire this rule once
// supported Codex versions no longer span that cache-schema change.
const BENIGN_CODEX_MODEL_CACHE_TTL_ERROR_SNIPPETS = [
  "codex_models_manager::manager",
  "failed to renew cache TTL",
  "missing field `supports_parallel_tool_calls`",
] as const;

export function isIgnorableCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.replaceAll(ANSI_SGR_ESCAPE_REGEX, "").trim();
  if (normalized.length === 0) {
    return false;
  }

  if (BENIGN_CODEX_PROCESS_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet))) {
    return true;
  }

  if (
    BENIGN_CODEX_MODEL_CACHE_TTL_ERROR_SNIPPETS.every((snippet) => normalized.includes(snippet))
  ) {
    return true;
  }

  return (
    normalized.includes("opentelemetry_sdk") &&
    BENIGN_CODEX_TELEMETRY_EXPORT_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet))
  );
}
