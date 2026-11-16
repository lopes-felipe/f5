import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { ExpandableErrorText } from "./ExpandableErrorText";

export function getThreadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return error;
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError))
    return error;
  return typeof nestedError.message === "string" && nestedError.message.trim().length > 0
    ? nestedError.message
    : error;
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  occurredAt,
  onDismiss,
}: {
  error: string | null;
  occurredAt?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertDescription className="min-w-0" title={error}>
        <ExpandableErrorText
          key={error}
          text={error}
          collapsedText={getThreadErrorBannerMessage(error)}
        />
        {occurredAt ? (
          <time className="mt-1 block text-2xs text-muted-foreground" dateTime={occurredAt}>
            {new Date(occurredAt).toLocaleString()}
          </time>
        ) : null}
      </AlertDescription>
      {onDismiss && (
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss error"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      )}
    </Alert>
  );
});
