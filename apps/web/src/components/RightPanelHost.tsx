import type { ThreadId } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";

import { usePreviewPresentationStore } from "../previewPresentationStore";
import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import { RightPanelTabs } from "./RightPanelTabs";
import { SurfaceErrorBoundary } from "./ui/SurfaceErrorBoundary";

export function RightPanelHost(props: {
  mode: "sidebar" | "sheet";
  threadId: ThreadId;
  state: ThreadRightPanelState;
  renderSurface: (surface: RightPanelSurface) => ReactNode;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddPreview: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
  onAddPlan: () => void;
  onAddAgents: () => void;
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
}) {
  useEffect(
    () => () => {
      const store = useRightPanelStore.getState();
      if (store.tabMenuThreadId === props.threadId) store.setTabMenuThread(null);
    },
    [props.threadId],
  );
  const tabMenuOpen = useRightPanelStore((state) => state.tabMenuThreadId === props.threadId);
  const previewPresentation = usePreviewPresentationStore(
    (state) => state.byThreadId[String(props.threadId)],
  );
  const activeSurface =
    props.state.surfaces.find((surface) => surface.id === props.state.activeSurfaceId) ?? null;
  const previewSurface = props.state.surfaces.find((surface) => surface.kind === "preview") ?? null;
  const inactivePreviewSurface =
    previewSurface && previewSurface.id !== activeSurface?.id ? previewSurface : null;

  return (
    <RightPanelTabs
      mode={props.mode}
      onMoveSurface={(from, to) =>
        useRightPanelStore.getState().moveSurface(props.threadId, from, to)
      }
      tabMenuOpen={tabMenuOpen}
      onTabMenuOpenChange={(open) =>
        useRightPanelStore.getState().setTabMenuThread(open ? props.threadId : null)
      }
      surfaces={props.state.surfaces}
      activeSurfaceId={props.state.activeSurfaceId}
      onActivate={props.onActivate}
      onCloseSurface={props.onCloseSurface}
      onCloseOtherSurfaces={props.onCloseOtherSurfaces}
      onCloseSurfacesToRight={props.onCloseSurfacesToRight}
      onCloseAllSurfaces={props.onCloseAllSurfaces}
      onCopyFilePath={props.onCopyFilePath}
      onAddPreview={props.onAddPreview}
      onAddFiles={props.onAddFiles}
      onAddDiff={props.onAddDiff}
      onAddPlan={props.onAddPlan}
      onAddAgents={props.onAddAgents}
      previewAvailable={props.previewAvailable}
      filesAvailable={props.filesAvailable}
      diffAvailable={props.diffAvailable}
      planAvailable={props.planAvailable}
      agentsAvailable={props.agentsAvailable}
      liveAgentCount={props.liveAgentCount}
      previewPresentation={previewPresentation}
    >
      {activeSurface || inactivePreviewSurface ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {activeSurface ? (
            <div className="absolute inset-0 flex min-h-0 flex-col">
              <SurfaceErrorBoundary
                name={`right-panel:${activeSurface.kind}`}
                resetKeys={[props.threadId, activeSurface.id]}
              >
                {props.renderSurface(activeSurface)}
              </SurfaceErrorBoundary>
            </div>
          ) : null}
          {inactivePreviewSurface ? (
            <div
              aria-hidden="true"
              inert
              className="pointer-events-none invisible absolute inset-0 flex min-h-0 flex-col"
            >
              <SurfaceErrorBoundary
                name="right-panel:preview"
                resetKeys={[props.threadId, inactivePreviewSurface.id]}
              >
                {props.renderSurface(inactivePreviewSurface)}
              </SurfaceErrorBoundary>
            </div>
          ) : null}
        </div>
      ) : null}
    </RightPanelTabs>
  );
}
