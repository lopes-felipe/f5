import { OpenLinkAnchor } from "../OpenLinkAnchor";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getServerHttpOrigin } from "../../lib/serverHttpOrigin";
import { getPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { PrLinkPreview } from "./PrLinkPreview";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { SOURCE_CONTROL_MARKDOWN } from "@t3tools/shared/sourceControl";
import { remarkHardLineBreaks } from "./remarkHardLineBreaks";
import { createContext, useContext } from "react";
import { taskMarkerOffset } from "./markdownTasks";

const TaskOffset = createContext<number | null>(null);
function TaskCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: ((offset: number, checked: boolean) => void) | undefined;
}) {
  const offset = useContext(TaskOffset);
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={!onChange || offset === null}
      aria-label="Task complete"
      onChange={(event) => {
        if (offset !== null) onChange?.(offset, event.target.checked);
      }}
    />
  );
}

export function prMediaUrl(src: string, host: string): string {
  try {
    const url = new URL(src);
    if (url.protocol !== "https:") return "";
    if (
      !["github.com", "githubusercontent.com"].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      return url.href;
  } catch {
    return "";
  }
  const params = new URLSearchParams({ url: src, host });
  const accountId = getPrHubSelectedAccountId();
  if (accountId) params.set("accountId", accountId);
  return `${getServerHttpOrigin()}/api/prhub/media?${params}`;
}
export function PrMarkdown({
  body,
  host,
  provider = host === "github.com" ? "github" : "unknown",
  onTaskChange,
}: {
  body: string;
  host: string;
  provider?: SourceControlProviderKind;
  onTaskChange?: ((offset: number, checked: boolean) => void) | undefined;
}) {
  const videos = new Set<string>();
  const replacements: Array<{ end: number; delta: number }> = [];
  let delta = 0;
  // Extract only a quoted HTTPS video source; all other HTML remains escaped.
  const markdown = body.replace(
    /<video\b[^>]*\bsrc=["'](https:\/\/[^"'<>\s]+)["'][^>]*>(?:[\s\S]*?<\/video>)?/gi,
    (tag: string, src: string, offset: number) => {
      videos.add(src);
      const replacement = `[Pull request video](${src})`;
      delta += replacement.length - tag.length;
      replacements.push({ end: offset + tag.length + delta, delta });
      return replacement;
    },
  );
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={
          SOURCE_CONTROL_MARKDOWN[provider].hardLineBreaks
            ? [remarkGfm, remarkHardLineBreaks]
            : [remarkGfm]
        }
        components={{
          li: ({ node, children, ...props }) => {
            const start = node?.position?.start.offset;
            const shift =
              start === undefined
                ? 0
                : (replacements.findLast((entry) => entry.end <= start)?.delta ?? 0);
            const offset = start === undefined ? null : taskMarkerOffset(body, start - shift);
            return (
              <li {...props}>
                <TaskOffset.Provider value={offset}>{children}</TaskOffset.Provider>
              </li>
            );
          },
          input: ({ checked }) => (
            <TaskCheckbox checked={Boolean(checked)} onChange={onTaskChange} />
          ),
          img: ({ src, alt }) =>
            typeof src === "string" ? (
              <img
                referrerPolicy="no-referrer"
                loading="lazy"
                src={prMediaUrl(src, host)}
                alt={alt ?? ""}
              />
            ) : null,
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            const isPr =
              /\/(pull|pulls|pull-requests|pullrequests|merge_requests|pullrequest)\/\d+/.test(
                href,
              );
            if (isPr) return <PrLinkPreview url={href}>{children}</PrLinkPreview>;
            if (videos.has(href) || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(href))
              return (
                <video
                  controls
                  preload="none"
                  src={prMediaUrl(href, host)}
                  aria-label="Pull request video"
                />
              );
            return (
              <OpenLinkAnchor href={href} target="_blank" rel="noreferrer">
                {children}
              </OpenLinkAnchor>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
