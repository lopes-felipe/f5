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
    <Alert variant="warning">
      <CircleAlertIcon />
      <AlertTitle>Send status could not be confirmed</AlertTitle>
      <AlertDescription>
        The connection dropped before this send was confirmed. Retry the original send or restore
        the draft.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" onClick={onRetrySend}>
          Retry send
        </Button>
        <Button size="sm" variant="outline" onClick={onRestoreDraft}>
          Restore draft
        </Button>
      </AlertAction>
    </Alert>
  );
});
