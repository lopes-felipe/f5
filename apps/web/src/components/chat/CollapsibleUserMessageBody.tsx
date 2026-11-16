import { memo, useState, type ReactNode } from "react";
import { buildCollapsedUserMessageText, shouldCollapseUserMessage } from "./userMessageCollapse";

/** Share collapse behavior while letting the timeline retain its skill and terminal chips. */
export const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  collapseAllowed?: boolean;
  forceExpandedForFind?: boolean;
  preservesCollapsedPrefix?: (text: string) => boolean;
  renderBody?: (text: string, collapsed: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsedText = buildCollapsedUserMessageText(props.text);
  const canCollapse =
    props.collapseAllowed !== false &&
    shouldCollapseUserMessage(props.text) &&
    (props.preservesCollapsedPrefix?.(collapsedText) ?? true);
  const collapsed = canCollapse && !expanded && !props.forceExpandedForFind;
  const text = collapsed ? collapsedText : props.text;
  return (
    <>
      {props.renderBody ? (
        props.renderBody(text, collapsed)
      ) : (
        <p className="whitespace-pre-wrap break-words">{text}</p>
      )}
      {canCollapse && !props.forceExpandedForFind ? (
        <button
          type="button"
          className="mt-1 text-2xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
});
