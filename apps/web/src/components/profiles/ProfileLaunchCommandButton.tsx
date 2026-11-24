import type { ProfileSummary } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hasProfileLaunchCommand, profileLaunchCommand } from "./profileStatus";

/**
 * Copies `t3 --profile <slug>` with visible confirmation. The old inline
 * button wrote to the clipboard and said nothing at all. Renders nothing for a
 * profile without a launch command (Linux VM).
 */
export function ProfileLaunchCommandButton({ profile }: { readonly profile: ProfileSummary }) {
  return hasProfileLaunchCommand(profile) ? <LaunchCommandButton profile={profile} /> : null;
}

function LaunchCommandButton({ profile }: { readonly profile: ProfileSummary }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const command = profileLaunchCommand(profile);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={() => copyToClipboard(command, undefined)}
            aria-label={`Copy launch command for ${profile.name}`}
          >
            {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </Button>
        }
      />
      <TooltipPopup side="top">{isCopied ? "Copied" : `Copy “${command}”`}</TooltipPopup>
    </Tooltip>
  );
}
