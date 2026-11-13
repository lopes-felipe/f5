import { useEffect, useRef } from "react";
import LargeTextViewer from "./LargeTextViewer";
export default function ReadOnlySourcePreview(props: {
  name: string;
  text: string;
  onPostRender?: (node: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) props.onPostRender?.(ref.current);
  }, [props.text, props.onPostRender]);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <LargeTextViewer name={props.name} text={props.text} delimiter={null} />
    </div>
  );
}
