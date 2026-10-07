import { memo, type ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  occurredAt,
  onDismiss,
  action,
}: {
  error: string | null;
  action?: ReactNode;
  occurredAt?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertDescription className="min-w-0" title={error}>
        <span className="line-clamp-3">{error}</span>
        {occurredAt ? (
          <time className="mt-1 block text-2xs text-muted-foreground" dateTime={occurredAt}>
            {new Date(occurredAt).toLocaleString()}
          </time>
        ) : null}
        {action}
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
