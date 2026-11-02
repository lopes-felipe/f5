import type { DatabaseDamage } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { onDatabaseDamaged, onServerWelcome } from "../wsNativeApi";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/**
 * Persistent warning shown once the backend reports a damaged profile database.
 * Its in-memory state is the best remaining copy, so the banner cannot be
 * dismissed and tells the user not to quit.
 */
export function DatabaseDamageBanner() {
  const [damage, setDamage] = useState<DatabaseDamage | null>(null);
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
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[100] flex justify-center px-4">
      <Alert
        variant="error"
        role="alert"
        className="no-drag pointer-events-auto max-w-2xl shadow-lg"
      >
        <TriangleAlertIcon />
        <AlertTitle>The F5 database is damaged. Do not quit F5.</AlertTitle>
        <AlertDescription>
          <p>
            {damage.databasePath} reported "{damage.message}". This window still holds your threads
            in memory. Quitting or restarting F5 would discard them.
          </p>
          <p>
            {damage.recoveryFile
              ? `A recovery copy was saved to ${damage.recoveryFile}.`
              : "Saving a recovery copy of your threads…"}
          </p>
          {damage.latestSnapshot && <p>Newest automatic snapshot: {damage.latestSnapshot}</p>}
          <p>Storage cleanup and database snapshots are paused.</p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
