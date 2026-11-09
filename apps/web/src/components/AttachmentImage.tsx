import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentProps,
  type SyntheticEvent,
} from "react";
import { fetchImageAttachmentBlob } from "./chat/imageAttachmentActions";
import { decodeHeicPreview } from "../lib/heicPreview";
import { MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES } from "../lib/imageCompression.core";
import {
  processComposerImageTaskBounded,
  withImageCompressionTimeout,
} from "../lib/imageCompression";

export type AttachmentImageProps = ComponentProps<"img"> & {
  name: string;
  mimeType?: string | undefined;
  sourceBlob?: Blob | undefined;
};

export function isHeicAttachment(name: string, mimeType = "") {
  return /^image\/hei[cf](?:-sequence)?$/i.test(mimeType) || /\.hei[cf]$/i.test(name);
}

export function AttachmentImage({ name, mimeType, sourceBlob, ...props }: AttachmentImageProps) {
  return isHeicAttachment(name, mimeType) ? (
    <HeicImage key={props.src} {...props} name={name} sourceBlob={sourceBlob} />
  ) : (
    <img {...props} />
  );
}

function HeicImage({
  name,
  src,
  sourceBlob,
  mimeType: _mimeType,
  onError,
  ...props
}: AttachmentImageProps) {
  const [error, setError] = useState<SyntheticEvent<HTMLImageElement> | null>(null);
  const [decoded, setDecoded] = useState<string>();
  const reportError = useEffectEvent((event: SyntheticEvent<HTMLImageElement>) => onError?.(event));
  useEffect(() => {
    if (!error || !src) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const result = await processComposerImageTaskBounded(
          () =>
            withImageCompressionTimeout(async (signal) => {
              const blob = await fetchImageAttachmentBlob(
                { src, name, mimeType: "image/heic", ...(sourceBlob ? { sourceBlob } : {}) },
                { signal, maxBytes: MAX_COMPRESSIBLE_IMAGE_SOURCE_BYTES },
              );
              if (signal.aborted) return { ok: false, reason: "cancelled" };
              return decodeHeicPreview(blob, name, signal);
            }, controller.signal),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.ok) throw new Error("HEIC conversion failed.");
        url = URL.createObjectURL(result.file);
        setDecoded(url);
      } catch {
        if (!controller.signal.aborted) reportError(error);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [error, src, name, sourceBlob]);
  return <img {...props} src={decoded ?? src} onError={error ? onError : setError} />;
}
