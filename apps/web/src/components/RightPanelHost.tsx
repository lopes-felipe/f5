import type { ReactNode } from "react";

import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import { RightPanelTabs } from "./RightPanelTabs";

export function RightPanelHost(props: {
  mode: "sidebar" | "sheet";
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
  previewAvailable: boolean;
  filesAvailable: boolean;
  diffAvailable: boolean;
  planAvailable: boolean;
}) {
  const activeSurface =
    props.state.surfaces.find((surface) => surface.id === props.state.activeSurfaceId) ?? null;

  return (
    <RightPanelTabs
      mode={props.mode}
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
      previewAvailable={props.previewAvailable}
      filesAvailable={props.filesAvailable}
      diffAvailable={props.diffAvailable}
      planAvailable={props.planAvailable}
    >
      {activeSurface ? props.renderSurface(activeSurface) : null}
    </RightPanelTabs>
  );
}
