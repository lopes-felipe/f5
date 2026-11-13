import { memo, useState } from "react";
import {
  chatGptUsageLimitCode,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_USAGE_URL,
} from "@t3tools/shared/usageLimit";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
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
  const [copyStatus, setCopyStatus] = useState<{ error: string; message: string } | null>(null);
  if (!error) return null;
  const code = chatGptUsageLimitCode(error);
  const workspaceLimit = code === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  return (
    <Alert variant={code ? "warning" : "error"}>
      <CircleAlertIcon />
      <AlertDescription className="min-w-0" title={error}>
        {code ? (
          <div className="space-y-2">
            <p className="font-medium">ChatGPT usage limit reached</p>
            <p>
              {workspaceLimit
                ? "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
                : "Review your usage settings in ChatGPT."}
            </p>
            {workspaceLimit ? (
              <Button
                size="sm"
                onClick={() => {
                  void writeTextToClipboard(CHATGPT_WORKSPACE_ADMIN_REQUEST).then(
                    () =>
                      setCopyStatus({
                        error,
                        message: "Request copied. Send it to your workspace admin.",
                      }),
                    () =>
                      setCopyStatus({ error, message: "Could not copy the request. Try again." }),
                  );
                }}
              >
                Copy request for admin
              </Button>
            ) : (
              <Button
                size="sm"
                render={<a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" />}
              >
                Manage usage
              </Button>
            )}
            {copyStatus?.error === error ? <p role="status">{copyStatus.message}</p> : null}
          </div>
        ) : (
          <ExpandableErrorText
            key={error}
            text={error}
            collapsedText={getThreadErrorBannerMessage(error)}
          />
        )}
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
