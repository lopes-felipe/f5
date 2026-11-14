import { useQuery } from "@tanstack/react-query";
import { MermaidDiagram } from "../chat/MermaidDiagram";
import { useTheme } from "../../hooks/useTheme";
import { readBoundedPreview } from "./readBoundedPreview";
export default function MermaidFileViewer({ src }: { src: string }) {
  const { resolvedTheme } = useTheme();
  const result = useQuery({
    queryKey: ["mermaid-file", src],
    queryFn: ({ signal }) =>
      readBoundedPreview(src, signal, 1024 * 1024).then((bytes) =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
  });
  if (result.isError) return <p role="alert">Cannot preview this diagram.</p>;
  if (!result.data) return <p>Loading diagram…</p>;
  return (
    <MermaidDiagram source={result.data} theme={resolvedTheme} code={<pre>{result.data}</pre>} />
  );
}
