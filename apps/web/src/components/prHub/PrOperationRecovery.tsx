import { useState } from "react";
import { Button } from "../ui/button";

export function PrOperationRecovery({
  kind,
  busy,
  onRecover,
}: {
  kind: "review" | "reply";
  busy: boolean;
  onRecover: (action: "link" | "abandon", remoteId?: string) => void;
}) {
  const [remoteId, setRemoteId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const label = kind === "review" ? "GitHub review ID" : "GitHub comment node ID";
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <label className="flex gap-2 text-xs">
        {label}
        <input
          aria-label={label}
          className="rounded border border-border bg-background px-2"
          value={remoteId}
          onChange={(event) => setRemoteId(event.target.value)}
        />
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || (kind === "review" ? !/^[0-9]+$/.test(remoteId) : !remoteId.trim())}
        onClick={() => onRecover("link", remoteId.trim())}
      >
        Verify linked {kind}
      </Button>
      <label className="flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I checked GitHub. Abandoning recovery keeps the draft but does not undo a {kind} that may
        have been published. A new submission could duplicate it.
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !confirmed}
        onClick={() => onRecover("abandon")}
      >
        Abandon recovery and unlock draft
      </Button>
    </div>
  );
}
