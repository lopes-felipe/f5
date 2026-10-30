import { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useThreadTitle } from "../../threadSelectors";
import { cn } from "../../lib/utils";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A referenced thread shown by its current title. A rename updates the chip; the saved prompt
 * keeps the label it was sent with.
 */
export function ThreadReferenceChip(props: {
  readonly threadId: string;
  readonly label: string;
  /** Open the thread on click when it still exists. */
  readonly link?: boolean;
  readonly className?: string;
}) {
  const threadId = ThreadId.makeUnsafe(props.threadId);
  const title = useThreadTitle(threadId);
  const available = title !== null;
  const label = title ?? props.label;
  const chip = (
    <span
      contentEditable={false}
      spellCheck={false}
      className={cn(
        COMPOSER_INLINE_CHIP_CLASS_NAME,
        !available && "text-muted-foreground",
        props.className,
      )}
      data-thread-reference={props.threadId}
    >
      <MessagesSquareIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.link && available ? (
            <Link
              to="/$threadId"
              params={{ threadId }}
              className="inline-flex max-w-full align-middle no-underline"
            />
          ) : (
            <span className="inline-flex max-w-full align-middle" />
          )
        }
      >
        {chip}
      </TooltipTrigger>
      <TooltipPopup className="max-w-[30rem] break-words">
        {available ? label : "Thread no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
