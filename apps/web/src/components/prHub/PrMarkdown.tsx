import { OpenLinkAnchor } from "../OpenLinkAnchor";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getServerHttpOrigin } from "../../lib/serverHttpOrigin";
import { getPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { PrLinkPreview } from "./PrLinkPreview";

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
export function PrMarkdown({ body, host }: { body: string; host: string }) {
  const videos = new Set<string>();
  // Extract only a quoted HTTPS video source; all other HTML remains escaped.
  const markdown = body.replace(
    /<video\b[^>]*\bsrc=["'](https:\/\/[^"'<>\s]+)["'][^>]*>(?:[\s\S]*?<\/video>)?/gi,
    (_tag, src: string) => {
      videos.add(src);
      return `[Pull request video](${src})`;
    },
  );
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
