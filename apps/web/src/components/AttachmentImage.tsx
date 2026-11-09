import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentProps,
  type SyntheticEvent,
} from "react";

export type AttachmentImageProps = ComponentProps<"img"> & {
  name: string;
  mimeType?: string | undefined;
};

export function isHeicAttachment(name: string, mimeType = "") {
  return /^image\/hei[cf](?:-sequence)?$/i.test(mimeType) || /\.hei[cf]$/i.test(name);
}

export function AttachmentImage({ name, mimeType, ...props }: AttachmentImageProps) {
  return isHeicAttachment(name, mimeType) ? (
    <HeicImage key={props.src} {...props} name={name} />
  ) : (
    <img {...props} />
  );
}

function HeicImage({ name, src, onError, ...props }: AttachmentImageProps) {
  const [error, setError] = useState<SyntheticEvent<HTMLImageElement> | null>(null);
  const [decoded, setDecoded] = useState<string>();
  const reportError = useEffectEvent((event: SyntheticEvent<HTMLImageElement>) => onError?.(event));
  useEffect(() => {
    if (!error || !src) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error("Image unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const { heicTo } = await import("heic-to/csp");
        if (controller.signal.aborted) return;
        const jpeg = await heicTo({ blob, type: "image/jpeg", quality: 0.9 });
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(jpeg);
        setDecoded(url);
      } catch {
        if (!controller.signal.aborted) reportError(error);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [error, src, name]);
  return <img {...props} src={decoded ?? src} onError={error ? onError : setError} />;
}
