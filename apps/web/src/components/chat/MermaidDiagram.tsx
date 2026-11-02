import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { peekRenderedMermaid, renderMermaid } from "../../lib/renderMermaid";

export function MermaidDiagram({
  source,
  theme,
  code,
}: {
  source: string;
  theme: "light" | "dark";
  code: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const key = `${theme}\u0000${source}`;
  // Streaming and settled messages are separate trees, so a diagram remounts when its
  // response finishes. A cached render shows immediately instead of loading again.
  const [result, setResult] = useState<{ key: string; svg?: string; failed?: boolean } | null>(
    () => {
      const svg = peekRenderedMermaid(source, theme);
      return svg === null ? null : { key, svg };
    },
  );
  const [visible, setVisible] = useState(result !== null);
  const [showCode, setShowCode] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const current = result?.key === key ? result : null;
  const svg = current?.svg;
  const [image, setImage] = useState<{ svg: string; url: string } | null>(null);
  const url = svg !== undefined && image?.svg === svg ? image.url : undefined;

  // Before paint, so a cached diagram never shows the loading state.
  useLayoutEffect(() => {
    if (svg === undefined) return;
    const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setImage({ svg, url: objectUrl });
    return () => URL.revokeObjectURL(objectUrl);
  }, [svg]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void renderMermaid(source, theme, controller.signal).then(
      (rendered) => {
        if (controller.signal.aborted) return;
        setResult((previous) =>
          previous?.key === key && previous.svg === rendered ? previous : { key, svg: rendered },
        );
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      },
    );
    return () => controller.abort();
  }, [attempt, key, source, theme, visible]);

  return (
    <div ref={hostRef} data-mermaid-diagram className="min-h-24">
      <div className="flex min-h-8 items-center gap-2 px-3 py-1 pr-12 text-xs text-muted-foreground">
        <button
          type="button"
          className="underline underline-offset-2"
          aria-pressed={showCode}
          onClick={() => setShowCode((value) => !value)}
        >
          {showCode ? "Show diagram" : "Show code"}
        </button>
        {!showCode && current?.failed ? (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              setResult(null);
              setAttempt((value) => value + 1);
            }}
          >
            Retry diagram
          </button>
        ) : null}
      </div>
      {showCode ? (
        code
      ) : current?.failed ? (
        <div>
          <p role="status" className="px-3 text-xs text-muted-foreground">
            Unable to render diagram. You can view or copy its source.
          </p>
          {code}
        </div>
      ) : url ? (
        <img
          src={url}
          alt="Mermaid diagram"
          className="mx-auto h-auto max-w-full p-3"
          onError={() => setResult({ key, failed: true })}
        />
      ) : (
        // The source holds its own height, so streamed text below does not jump twice.
        <>
          <p role="status" className="sr-only">
            Rendering diagram…
          </p>
          <div className="invisible" aria-hidden="true">
            {code}
          </div>
        </>
      )}
    </div>
  );
}
