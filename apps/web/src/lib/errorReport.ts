import { toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected error occurred.";
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  // JSON.stringify returns undefined for undefined, functions and symbols.
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    try {
      return String(error);
    } catch {
      return "No additional error details are available.";
    }
  }
}

/** Copies the error's details and reports the result as a toast. */
export function copyErrorReport(error: unknown, context?: string): void {
  const details = errorDetails(error);
  void writeTextToClipboard(context ? `${context}\n\n${details}` : details).then(
    () => toastManager.add({ type: "success", title: "Error report copied" }),
    () => toastManager.add({ type: "error", title: "Could not copy error report" }),
  );
}
