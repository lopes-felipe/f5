import type { OrchestrationAuthFailure, ThreadId } from "@t3tools/contracts";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { KeyRoundIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { readNativeApi } from "../../nativeApi";
import { ProviderAccountPanel } from "../settings/ProviderAccountPanel";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ExpandableErrorText } from "./ExpandableErrorText";
import { getThreadErrorBannerMessage } from "./ThreadErrorBanner";

/**
 * A turn failed because the provider login expired. One click signs in again
 * through the provider's own CLI flow and, once that succeeds, resends the
 * message, but only when the server confirms the turn never started working.
 * If the thread was busy at that moment, a plain Resend stays available so a
 * retry doesn't need another sign-in.
 */
export function AuthFailureNotice(props: {
  readonly threadId: ThreadId;
  readonly failure: OrchestrationAuthFailure;
  readonly providerLabel: string;
  readonly driver: string;
  readonly error: string;
  readonly onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [resending, setResending] = useState(false);
  // One resend per failure, however many times the login reports success.
  const resentKey = useRef<string | null>(null);
  const failureKey = authFailureKey(props.failure);
  // Signed in, but the thread was busy: offer Resend instead of another sign-in.
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const canResend = failureKey !== null && retryKey === failureKey;

  const resend = async () => {
    const api = readNativeApi();
    if (!api || !failureKey || resentKey.current === failureKey) return;
    resentKey.current = failureKey;
    setResending(true);
    try {
      const result = await api.nextTurnQueue.resendAuthFailedTurn({
        threadId: props.threadId,
        expectedFailureKey: failureKey,
      });
      setOpen(false);
      if (result.kind === "sent") {
        setRetryKey(null);
        toastManager.add({
          type: "success",
          title: `Signed in to ${props.providerLabel}`,
          description: "Resending your message.",
        });
        return;
      }
      resentKey.current = null;
      setRetryKey(result.kind === "busy" ? failureKey : null);
      toastManager.add({
        type: result.kind === "busy" ? "warning" : "info",
        title: `Signed in to ${props.providerLabel}`,
        description: result.reason ?? "Send your message again to continue.",
      });
    } catch (error) {
      resentKey.current = null;
      toastManager.add({
        type: "error",
        title: "Could not resend the message",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResending(false);
    }
  };

  return (
    <>
      <Alert variant="error" data-slot="auth-failure-notice">
        <KeyRoundIcon />
        <AlertTitle>Your {props.providerLabel} login expired</AlertTitle>
        <AlertDescription className="min-w-0" title={props.error}>
          <ExpandableErrorText
            key={props.error}
            text={props.error}
            collapsedText={getThreadErrorBannerMessage(props.error)}
          />
        </AlertDescription>
        <AlertAction>
          {canResend ? (
            <Button size="xs" disabled={resending} onClick={() => void resend()}>
              Resend
            </Button>
          ) : null}
          <Button
            size="xs"
            variant={canResend ? "outline" : "default"}
            disabled={resending}
            onClick={() => setOpen(true)}
          >
            Sign in again
          </Button>
          <button
            type="button"
            aria-label="Dismiss error"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={props.onDismiss}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign in to {props.providerLabel}</DialogTitle>
            <DialogDescription>
              Finish signing in below. If the turn never started, your message is sent again as soon
              as the login succeeds.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {open ? (
              <ProviderAccountPanel
                instanceId={props.failure.providerInstanceId}
                driver={props.driver}
                status="unauthenticated"
                autoStart
                cancelOnUnmount
                onLoginFinished={(succeeded) => {
                  if (succeeded) void resend();
                }}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
