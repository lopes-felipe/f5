import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { SurfaceErrorBoundary } from "../ui/SurfaceErrorBoundary";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { observeResize } from "../../lib/observeResize";

const MathTypeset = lazy(() => import("./MathTypeset"));

export function MarkdownMath({ tex, display }: { tex: string; display: boolean }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const measure = () => setOverflows(outer.scrollWidth > outer.clientWidth);
    measure();
    return observeResize([outer, inner], measure);
  }, []);
  const source = display ? "\\[\n" + tex.trim() + "\n\\]" : "\\(" + tex.trim() + "\\)";
  const fallback = <code className="whitespace-pre-wrap">{source}</code>;
  return (
    <span
      ref={viewport}
      tabIndex={overflows ? 0 : -1}
      aria-label={overflows ? "Scroll equation" : undefined}
      className={
        display
          ? "my-2 block max-w-full overflow-x-auto"
          : "inline-block max-w-full overflow-x-auto align-middle"
      }
      data-markdown-math={display ? "display" : "inline"}
      data-markdown-copy={source}
    >
      <span ref={content} className="inline-block w-max">
        <SurfaceErrorBoundary name="math" resetKeys={[tex, display]} fallback={fallback}>
          <Suspense fallback={fallback}>
            <MathTypeset tex={tex} display={display} />
          </Suspense>
        </SurfaceErrorBoundary>
      </span>
      <button
        type="button"
        className="ml-1 text-xs text-muted-foreground"
        aria-label="Copy TeX source"
        title="Copy TeX source"
        onClick={() => {
          void writeTextToClipboard(source).catch(() => undefined);
        }}
      >
        TeX
      </button>
    </span>
  );
}
