import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderMermaid } from "../../lib/renderMermaid";

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
  const [visible, setVisible] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url?: string; failed?: boolean } | null>(
    null,
  );
  const key = `${theme}\u0000${source}`;
  const current = result?.key === key ? result : null;

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
    let url: string | undefined;
    void renderMermaid(source, theme, controller.signal).then(
      (svg) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setResult({ key, url });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
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
      ) : current?.url ? (
        <img
          src={current.url}
          alt="Mermaid diagram"
          className="mx-auto h-auto max-w-full p-3"
          onError={() => setResult({ key, failed: true })}
        />
      ) : (
        <p role="status" className="px-3 py-6 text-xs text-muted-foreground">
          Rendering diagram…
        </p>
      )}
    </div>
  );
}
