import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

export const PendingSendRecoveryBanner = memo(function PendingSendRecoveryBanner({
  visible,
  onRetrySend,
  onRestoreDraft,
}: {
  visible: boolean;
  onRetrySend: () => void;
  onRestoreDraft: () => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div className="mx-auto max-w-3xl px-3 pt-3 sm:px-5">
      <Alert variant="warning">
        <CircleAlertIcon />
        <AlertTitle>Send status could not be confirmed</AlertTitle>
        <AlertDescription>
          The connection dropped before this send was confirmed. Retry the original send or restore
          the draft.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" className="rounded-full px-3" onClick={onRetrySend}>
            Retry send
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full px-3"
            onClick={onRestoreDraft}
          >
            Restore draft
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
