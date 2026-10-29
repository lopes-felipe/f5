import type { TextRevision } from "../../lib/streamingTextRevision";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { formatCompactTokens } from "./composer/contextMeter.logic";
import { cn } from "~/lib/utils";

interface ReasoningSectionProps {
  reasoningText: string;
  textRevision?: TextRevision | undefined;
  reasoningTokens?: number | undefined;
  reasoningTokensEstimated?: boolean | undefined;
  defaultExpanded: boolean;
  isStreaming: boolean;
  cwd: string | undefined;
}

function ReasoningLabel(props: {
  isStreaming: boolean;
  reasoningTokens: number | undefined;
  reasoningTokensEstimated: boolean | undefined;
}) {
  const tokens = props.reasoningTokens ?? 0;
  return (
    <>
      <BotIcon className="size-3.5 shrink-0 text-faint-foreground" />
      <span>{props.isStreaming ? "Thinking…" : "Thought"}</span>
      {tokens > 0 ? (
        <span
          className="tabular-nums text-faint-foreground"
          title={props.reasoningTokensEstimated ? "Approximate estimate" : "Reported by provider"}
        >
          · {props.reasoningTokensEstimated ? "~" : ""}
          {formatCompactTokens(tokens)} tokens
        </span>
      ) : null}
    </>
  );
}

export function ReasoningSection({
  reasoningText,
  textRevision,
  reasoningTokens,
  reasoningTokensEstimated,
  defaultExpanded,
  isStreaming,
  cwd,
}: ReasoningSectionProps) {
  const [open, setOpen] = useState(defaultExpanded);
  const [userOverrode, setUserOverrode] = useState(false);

  useEffect(() => {
    if (userOverrode) {
      return;
    }
    if (isStreaming) {
      setOpen(true);
      return;
    }
    setOpen(defaultExpanded);
  }, [defaultExpanded, isStreaming, userOverrode]);

  const handleOpenChange = (nextOpen: boolean) => {
    setUserOverrode(true);
    setOpen(nextOpen);
  };

  const label = (
    <ReasoningLabel
      isStreaming={isStreaming}
      reasoningTokens={reasoningTokens}
      reasoningTokensEstimated={reasoningTokensEstimated}
    />
  );

  if (reasoningText.length === 0) {
    // A count without visible reasoning has nothing to expand.
    return (
      <div
        data-slot="reasoning-summary"
        className="mb-2 inline-flex items-center gap-1.5 px-1 py-1 text-2xs font-medium text-muted-foreground"
      >
        {label}
      </div>
    );
  }

  return (
    <Collapsible className="mb-2" open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-faint-foreground transition-transform duration-(--duration-fast)",
            open ? "rotate-180" : "",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="rounded-xl border border-border bg-card/50 p-3">
          <div className="text-ui text-muted-foreground">
            <ChatMarkdown
              textRevision={textRevision}
              text={reasoningText}
              cwd={cwd}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
