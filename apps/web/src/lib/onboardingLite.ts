import { useMemo } from "react";

import {
  getDisplayProfile,
  useAppSettings,
  type AppSettings,
  type DisplayProfile,
  type OnboardingLiteStatus,
} from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";
import type { Project, Thread } from "../types";

export type OnboardingLiteMode = "loading" | "onboarding" | "empty-projects" | "empty-threads";

export interface OnboardingLiteState {
  mode: OnboardingLiteMode;
  status: OnboardingLiteStatus;
  displayProfile: DisplayProfile;
  showProfileOverwriteWarning: boolean;
  validDraftThreadCount: number;
  shouldPromoteToCompleted: boolean;
}

interface OnboardingLiteSnapshot {
  settings: AppSettings;
  projects: ReadonlyArray<Project>;
  threads: ReadonlyArray<Thread>;
  draftThreadsByProjectId: ReadonlyMap<string, string>;
  threadsHydrated: boolean;
  recoveryEpoch: number;
}

function countValidDraftThreads(
  projects: ReadonlyArray<Project>,
  draftThreadsByProjectId: ReadonlyMap<string, string>,
): number {
  const validProjectIds = new Set<string>(projects.map((project) => project.id));
  let count = 0;
  for (const projectId of draftThreadsByProjectId.keys()) {
    if (validProjectIds.has(projectId)) {
      count += 1;
    }
  }
  return count;
}

export function deriveOnboardingLiteState(snapshot: OnboardingLiteSnapshot): OnboardingLiteState {
  const displayProfile = getDisplayProfile(snapshot.settings);
  const status = snapshot.settings.onboardingLiteStatus;
  const startupReady = snapshot.threadsHydrated && snapshot.recoveryEpoch > 0;
  const validDraftThreadCount = countValidDraftThreads(
    snapshot.projects,
    snapshot.draftThreadsByProjectId,
  );
  const totalKnownThreadCount = snapshot.threads.length + validDraftThreadCount;

  let mode: OnboardingLiteMode = "loading";
  if (startupReady) {
    if (status === "reopened") {
      mode = "onboarding";
    } else if (snapshot.projects.length === 0) {
      mode = status === "eligible" ? "onboarding" : "empty-projects";
    } else {
      mode = "empty-threads";
    }
  }

  return {
    mode,
    status,
    displayProfile,
    showProfileOverwriteWarning: displayProfile === "custom",
    validDraftThreadCount,
    shouldPromoteToCompleted:
      startupReady &&
      status === "eligible" &&
      snapshot.projects.length > 0 &&
      totalKnownThreadCount > 0,
  };
}

export function useOnboardingLiteState(): OnboardingLiteState {
  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const draftThreadIdsByProjectId = useComposerDraftStore(
    (store) => store.projectDraftThreadIdByProjectId,
  );
  const recoveryEpoch = useRecoveryStateStore((store) => store.recoveryEpoch);

  return useMemo(
    () =>
      deriveOnboardingLiteState({
        settings,
        projects,
        threads,
        draftThreadsByProjectId: new Map(Object.entries(draftThreadIdsByProjectId)),
        threadsHydrated,
        recoveryEpoch,
      }),
    [draftThreadIdsByProjectId, projects, recoveryEpoch, settings, threads, threadsHydrated],
  );
}
