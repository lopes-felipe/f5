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
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <BotIcon className="size-3.5 shrink-0 text-faint-foreground" />
        <span>{isStreaming ? "Thinking…" : "Thinking"}</span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-faint-foreground transition-transform duration-(--duration-fast)",
            open ? "rotate-180" : "",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="rounded-lg bg-muted/40 p-3">
          <div className="text-ui text-muted-foreground">
            <ChatMarkdown text={reasoningText} cwd={cwd} isStreaming={isStreaming} />
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
