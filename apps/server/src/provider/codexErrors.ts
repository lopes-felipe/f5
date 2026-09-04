const UNSUPPORTED_MODEL_RECOVERY_HINT =
  "Choose another model, or upgrade Codex CLI and verify that your account has access.";

export function isUnsupportedCodexModelError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    /\b(?:unknown|unsupported)\s+(?:requested\s+)?model\b/u.test(normalized) ||
    /\bmodel(?:\s+['"][^'"]+['"])?\s+(?:is\s+)?not supported\b/u.test(normalized) ||
    /\b(?:requested\s+)?model(?:\s+['"][^'"]+['"])?\s+not found\b/u.test(normalized)
  );
}

export function formatCodexUnsupportedModelError(message: string): string {
  return isUnsupportedCodexModelError(message)
    ? `${message} ${UNSUPPORTED_MODEL_RECOVERY_HINT}`
    : message;
}
