import { useEffect, useState } from "react";
import { decodeImagePreview } from "./decodeImagePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
export function PreviewImage(props: { src: string; name: string }) {
  const [result, setResult] = useState<{ src: string; error?: string }>();
  const needsDecode = /\.(heic|heif|tif|tiff)$/i.test(props.name);
  useEffect(() => {
    if (!needsDecode) return;
    const controller = new AbortController();
    let url: string | undefined;
    void decodeImagePreview(props.src, /\.(heic|heif)$/i.test(props.name), controller.signal)
      .then((value) => {
        url = URL.createObjectURL(value);
        if (controller.signal.aborted) URL.revokeObjectURL(url);
        else setResult({ src: url });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            src: "",
            error: error instanceof Error ? error.message : "Cannot decode image",
          });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [props.src, props.name, needsDecode]);
  if (needsDecode && !result) return <FileSurfaceLoading />;
  if (result?.error) return <FileSurfaceFailure message={result.error} />;
  return (
    <img
      alt={props.name}
      src={needsDecode ? result?.src : props.src}
      className="max-h-full max-w-full object-contain"
    />
  );
}
