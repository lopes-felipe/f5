import { useEffect, useState } from "react";
import type { ComputerGrant, ProjectId } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { SettingsCard, SettingsRow } from "./SettingsCard";
export function RememberedComputerApps({ projectId }: { projectId: ProjectId }) {
  const [grants, setGrants] = useState<ReadonlyArray<ComputerGrant>>([]);
  const [error, setError] = useState("");
  const refresh = async () =>
    setGrants((await readNativeApi()?.computer?.access.listRemembered({ projectId })) ?? []);
  useEffect(() => {
    void refresh().catch(() => setError("Could not read remembered apps."));
  }, [projectId]);
  return (
    <SettingsCard
      title="Always-allowed computer apps"
      description="Add apps through a computer access request. Forget removes the remembered grant for future sessions."
    >
      {grants.length ? (
        grants.map((grant) => (
          <SettingsRow
            key={grant.appId}
            title={grant.appId}
            description={`${grant.tier}${grant.allowTyping ? " · typing allowed" : ""}`}
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void readNativeApi()
                    ?.computer?.access.forgetRemembered({ projectId, appId: grant.appId })
                    .then(refresh)
                    .catch(() => setError("Could not forget this app."));
                }}
              >
                Forget
              </Button>
            }
          />
        ))
      ) : (
        <p className="text-sm text-muted-foreground">No remembered apps.</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </SettingsCard>
  );
}
