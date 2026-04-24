const BENIGN_CODEX_PROCESS_STDERR_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
] as const;

const BENIGN_CODEX_TELEMETRY_EXPORT_ERROR_SNIPPETS = [
  'name="BatchSpanProcessor.Flush.ExportError"',
  'name="BatchSpanProcessor.ExportError"',
  'name="BatchSpanProcessor.Export.Error"',
] as const;

export function isIgnorableCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (BENIGN_CODEX_PROCESS_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet))) {
    return true;
  }

  return (
    normalized.includes("opentelemetry_sdk") &&
    BENIGN_CODEX_TELEMETRY_EXPORT_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet))
  );
}
