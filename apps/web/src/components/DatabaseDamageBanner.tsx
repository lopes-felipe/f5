import type { DatabaseDamage } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { onDatabaseDamaged, onServerWelcome } from "../wsNativeApi";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

function recoveryCopyText(damage: DatabaseDamage): string {
  if (damage.recoveryFile) return `A recovery copy was saved to ${damage.recoveryFile}.`;
  if (damage.recoveryError) return `The recovery copy could not be saved: ${damage.recoveryError}`;
  if (damage.fromPreviousRun) return "No recovery copy was saved by the earlier run.";
  return "Saving a recovery copy of your threads…";
}

/**
 * Persistent warning shown while the backend reports a damaged profile
 * database. When the damage was found in this run, the in-memory state is the
 * best remaining copy, so the banner tells the user not to quit. It can be
 * collapsed to a single line so it never hides the controls beneath it.
 */
export function DatabaseDamageBanner() {
  const [damage, setDamage] = useState<DatabaseDamage | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const unsubscribeWelcome = onServerWelcome((payload) => {
      if (payload.databaseDamage) setDamage(payload.databaseDamage);
    });
    const unsubscribeDamage = onDatabaseDamaged(setDamage);
    return () => {
      unsubscribeWelcome();
      unsubscribeDamage();
    };
  }, []);

  if (!damage) return null;
  const title = damage.fromPreviousRun
    ? "The F5 database was damaged in an earlier session."
    : "The F5 database is damaged. Do not quit F5.";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[100] flex justify-center px-4">
      <Alert
        variant="error"
        role="alert"
        className="no-drag pointer-events-auto max-w-2xl shadow-lg"
      >
        <TriangleAlertIcon />
        <AlertTitle className="flex items-center justify-between gap-2">
          <span>{title}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={collapsed ? "Show details" : "Hide details"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        </AlertTitle>
        {!collapsed && (
          <AlertDescription>
            <p>
              {damage.databasePath} reported "{damage.message}".{" "}
              {damage.fromPreviousRun
                ? "This session loaded what was still readable, so restore from a recovery copy or snapshot before relying on it."
                : "This window still holds your threads in memory. Quitting or restarting F5 would discard them."}
            </p>
            <p>{recoveryCopyText(damage)}</p>
            {damage.latestSnapshot && <p>Newest automatic snapshot: {damage.latestSnapshot}</p>}
            <p>
              Storage cleanup and database snapshots stay paused until the database file is
              replaced. To resume them without restoring, delete {damage.markerPath}.
            </p>
          </AlertDescription>
        )}
      </Alert>
    </div>
  );
}
