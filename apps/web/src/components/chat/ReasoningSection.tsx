import { BotIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";

interface ReasoningSectionProps {
  reasoningText: string;
  defaultExpanded: boolean;
  isStreaming: boolean;
  cwd: string | undefined;
}

export function ReasoningSection({
  reasoningText,
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

  return (
    <Collapsible className="mb-2" open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground/80">
        <BotIcon className="size-3.5 shrink-0" />
        <span className="flex-1 uppercase tracking-[0.12em]">Thinking</span>
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform duration-200", open ? "rotate-180" : "")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="rounded-lg border border-border/40 bg-muted/15 p-3">
          <div className="text-[13px] text-muted-foreground/80">
            <ChatMarkdown text={reasoningText} cwd={cwd} isStreaming={isStreaming} />
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
