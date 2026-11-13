import { useQuery } from "@tanstack/react-query";
import ChatMarkdown from "./ChatMarkdown";
import { lazy, Suspense } from "react";
const LargeTextViewer = lazy(() => import("./files/LargeTextViewer"));

/** Preview text is bounded independently of the 50 MiB download limit. */
export function AssetTextView({
  url,
  markdown,
  name = "file.txt",
}: {
  url: string;
  markdown: boolean;
  name?: string;
}) {
  const result = useQuery({
    queryKey: ["asset-text", url],
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error("Unable to read attachment");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let text = "",
        bytes = 0,
        truncated = false;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const available = Math.max(0, 1024 * 1024 - bytes);
          text += decoder.decode(next.value.subarray(0, available), { stream: true });
          bytes += next.value.length;
          if (bytes > 1024 * 1024) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
        text += decoder.decode();
        return { text, truncated };
      } finally {
        reader.releaseLock();
      }
    },
    staleTime: 25 * 60 * 1000,
    enabled: markdown,
  });
  if (!markdown || result.data?.truncated)
    return (
      <Suspense fallback={<p>Loading preview…</p>}>
        <LargeTextViewer
          key={url}
          src={url}
          name={name}
          delimiter={/\.csv$/i.test(name) ? "," : /\.tsv$/i.test(name) ? "\t" : null}
        />
      </Suspense>
    );
  if (result.isError) return <p role="alert">Unable to read this attachment.</p>;
  if (!result.data) return <p>Loading preview…</p>;
  return (
    <div className="overflow-auto p-3">
      {result.data.truncated && (
        <p>Preview truncated at 1 MiB. Download the file to read it all.</p>
      )}
      {markdown ? (
        <ChatMarkdown text={result.data.text} cwd={undefined} />
      ) : (
        <pre className="whitespace-pre-wrap break-words">{result.data.text}</pre>
      )}
    </div>
  );
}
