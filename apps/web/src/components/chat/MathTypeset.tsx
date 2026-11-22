import katex from "katex";
import "katex/dist/katex.min.css";
import { LRUCache } from "../../lib/lruCache";
import { escapeLiteralPercents } from "./MathTypeset.logic";

const cache = new LRUCache<string>(500, 4 * 1024 * 1024);

export default function MathTypeset({ tex, display }: { tex: string; display: boolean }) {
  const key = String(display) + ":" + tex;
  let html = cache.get(key);
  if (html === null) {
    const options = {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: "ignore" as const,
      maxSize: 20,
      maxExpand: 1000,
    };
    try {
      html = katex.renderToString(tex, options);
    } catch {
      html = "";
      const repaired = escapeLiteralPercents(tex);
      if (repaired !== tex) {
        try {
          html = katex.renderToString(repaired, options);
        } catch {
          /* Keep the source readable. */
        }
      }
    }
    cache.set(key, html, (key.length + html.length) * 2);
  }
  return html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <code>{tex}</code>;
}
