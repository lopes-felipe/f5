import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DISPLAY_PROFILE_CUSTOM_WARNING,
  DISPLAY_PROFILE_DESCRIPTIONS,
  DISPLAY_PROFILE_LABELS,
  DISPLAY_PROFILE_NAMES,
  displayProfilePatchFor,
  getDisplayProfile,
  pickDisplayProfileValues,
  type AppSettings,
  type DisplayProfileKey,
  type DisplayProfileName,
} from "../../appSettings";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { toggleVariants } from "../ui/toggle";
import { cn } from "../../lib/utils";

interface DisplayProfileSelectorProps {
  readonly settings: Pick<AppSettings, DisplayProfileKey>;
  readonly updateSettings: (patch: Partial<AppSettings>) => void;
  readonly children?: ReactNode;
}

function isDisplayProfileName(value: string | undefined): value is DisplayProfileName {
  return DISPLAY_PROFILE_NAMES.some((name) => name === value);
}

export function DisplayProfileSelector({
  settings,
  updateSettings,
  children,
}: DisplayProfileSelectorProps) {
  const {
    alwaysExpandAgentCommandTranscripts,
    expandMcpToolCallCardsByDefault,
    expandMcpToolCalls,
    expandWorkflowThreadsByDefault,
    runtimeWarningVisibility,
    showAgentCommandTranscripts,
    showFileChangeDiffsInline,
    showProviderRuntimeMetadata,
    showReasoningExpanded,
  } = settings;
  const profileValues = useMemo(
    () =>
      pickDisplayProfileValues({
        alwaysExpandAgentCommandTranscripts,
        expandMcpToolCallCardsByDefault,
        expandMcpToolCalls,
        expandWorkflowThreadsByDefault,
        runtimeWarningVisibility,
        showAgentCommandTranscripts,
        showFileChangeDiffsInline,
        showProviderRuntimeMetadata,
        showReasoningExpanded,
      }),
    [
      alwaysExpandAgentCommandTranscripts,
      expandMcpToolCallCardsByDefault,
      expandMcpToolCalls,
      expandWorkflowThreadsByDefault,
      runtimeWarningVisibility,
      showAgentCommandTranscripts,
      showFileChangeDiffsInline,
      showProviderRuntimeMetadata,
      showReasoningExpanded,
    ],
  );
  const profile = useMemo(() => getDisplayProfile(profileValues), [profileValues]);
  const [open, setOpen] = useState(profile === "custom");

  useEffect(() => {
    if (profile === "custom") {
      setOpen(true);
    }
  }, [profile]);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-background/50 p-4">
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Display density</p>
          <p className="text-xs text-muted-foreground">
            Choose how much detail appears in threads. Presets adjust multiple settings at once.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            variant="outline"
            size="xs"
            value={profile === "custom" ? [] : [profile]}
            onValueChange={(value) => {
              const next = value[0];
              if (!isDisplayProfileName(next)) {
                return;
              }
              updateSettings(displayProfilePatchFor(next));
            }}
          >
            {DISPLAY_PROFILE_NAMES.map((name) => (
              <Toggle key={name} value={name}>
                {DISPLAY_PROFILE_LABELS[name]}
              </Toggle>
            ))}
          </ToggleGroup>

          <span
            className={cn(
              toggleVariants({ size: "xs", variant: "outline" }),
              "cursor-default border-dashed text-muted-foreground hover:bg-transparent",
              profile === "custom" ? "bg-input/64 text-foreground" : "opacity-80",
            )}
          >
            Custom
          </span>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{DISPLAY_PROFILE_DESCRIPTIONS[profile]}</p>
          {profile === "custom" ? <p>{DISPLAY_PROFILE_CUSTOM_WARNING}</p> : null}
        </div>
      </div>

      {children ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left">
            <span>
              <span className="block text-xs font-medium text-foreground">
                Show individual settings
              </span>
              <span className="block text-xs text-muted-foreground">
                Adjust each display option on its own.
              </span>
            </span>
            <Badge variant="outline">{open ? "Hide" : "Show"}</Badge>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-3 space-y-3">{children}</div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}
