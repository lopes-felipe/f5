const PREVIEW_NAVIGATION_ABORT_ERROR_CODE = -3; // Chromium net::ERR_ABORTED.

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isPreviewNavigationAbortError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  if (message.includes("ERR_ABORTED")) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    record.code === "ERR_ABORTED" ||
    record.errno === PREVIEW_NAVIGATION_ABORT_ERROR_CODE ||
    record.errorCode === PREVIEW_NAVIGATION_ABORT_ERROR_CODE
  );
}
