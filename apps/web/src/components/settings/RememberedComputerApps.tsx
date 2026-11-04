import { useCallback } from "react";
import type {
  ProjectId,
  RememberedComputerConsent,
  RememberedComputerConsentEntry,
} from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { SettingsCard } from "./SettingsCard";
import { RevocableConsentRow, useConsentList } from "./RevocableConsentRow";

function label(consent: RememberedComputerConsent): string {
  switch (consent.kind) {
    case "app-access":
      return consent.appId;
    case "session-actions":
      return "Session actions";
    case "full-access-session":
      return "Session approval in Full access threads";
    case "takeover":
      return "Full access foreground · " + consent.appId;
  }
}
function detail(entry: RememberedComputerConsentEntry): string {
  const consent = entry.consent;
  const scope =
    consent.kind === "app-access"
      ? consent.tier + (consent.allowTyping ? " · typing allowed" : "")
      : consent.kind === "session-actions"
        ? consent.background
          ? "Background and foreground"
          : "Foreground only"
        : consent.kind === "takeover"
          ? "Full access threads in this project"
          : "This profile";
  return (
    scope +
    (entry.persistence === "session-only"
      ? " · Until F5 closes. " + (entry.reason ?? "F5 could not save this choice.")
      : "")
  );
}
export function RememberedComputerApps({ projectId }: { projectId?: ProjectId }) {
  const bridge = window.desktopBridge?.computerAutomation;
  const projects = useStore((store) => store.projects);
  const load = useCallback(async (): Promise<ReadonlyArray<RememberedComputerConsentEntry>> => {
    if (bridge?.rememberedComputerConsents) return bridge.rememberedComputerConsents();
    const ids = projectId ? [projectId] : projects.map((project) => project.id);
    const lists = await Promise.all(
      ids.map(async (id) => ({
        id,
        grants: (await readNativeApi()?.computer?.access.listRemembered({ projectId: id })) ?? [],
      })),
    );
    return lists.flatMap(({ id, grants }) =>
      grants.flatMap((grant) =>
        grant.tier === "blocked"
          ? []
          : [
              {
                consent: {
                  version: 1 as const,
                  kind: "app-access" as const,
                  projectId: id,
                  appId: grant.appId,
                  tier: grant.tier,
                  allowTyping: grant.allowTyping,
                  policyVersion: 1,
                },
                persistence: "session-only" as const,
              },
            ],
      ),
    );
  }, [bridge, projectId, projects]);
  const { entries, error, refresh } = useConsentList(load);
  const filtered = entries.filter(
    (entry) =>
      !projectId || ("projectId" in entry.consent && entry.consent.projectId === projectId),
  );
  const groups = new Map<string, RememberedComputerConsentEntry[]>();
  for (const entry of filtered) {
    const id = "projectId" in entry.consent ? entry.consent.projectId : "";
    const key = !id
      ? "profile"
      : !projects.some((project) => project.id === id)
        ? "unlinked"
        : "project:" + id;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <SettingsCard
      title="Don't ask again"
      description="Native approvals are signed by F5 and scoped to this profile. Project permissions apply only to that project's ID."
    >
      {!bridge?.rememberedComputerConsents ? (
        <p className="text-sm text-muted-foreground">
          Manage permissions on the computer running F5.
        </p>
      ) : null}
      {[...groups].map(([id, list]) => (
        <div key={id}>
          <h4 className="text-sm font-medium">
            {id === "profile"
              ? "This profile"
              : id === "unlinked"
                ? "Unlinked projects"
                : projects.find((project) => "project:" + project.id === id)?.name}
          </h4>
          {list.map((entry) => (
            <RevocableConsentRow
              key={JSON.stringify(entry.consent)}
              title={label(entry.consent)}
              description={
                <>
                  {detail(entry)}
                  {"projectId" in entry.consent ? (
                    <span className="block text-xs text-muted-foreground">
                      Project ID: {entry.consent.projectId}
                    </span>
                  ) : null}
                </>
              }
              {...(bridge?.revokeRememberedComputerConsent
                ? { revoke: () => bridge.revokeRememberedComputerConsent!(entry.consent) }
                : {})}
              refreshed={refresh}
            />
          ))}
        </div>
      ))}
      {!filtered.length ? (
        <p className="text-sm text-muted-foreground">No remembered permissions.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </SettingsCard>
  );
}
