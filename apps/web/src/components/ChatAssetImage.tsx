import { AssetDocumentContext } from "./AssetDocumentContext";
import { resolveChatAssetTarget } from "../lib/chatAssetTarget";
import { AssetImageGallery, type AssetGalleryState } from "./AssetImageGallery";
import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectIssueAssetUrlInput } from "@t3tools/contracts";
import { useStore } from "../store";
import { readNativeApi } from "../nativeApi";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
import { useAppSettings } from "../appSettings";

type ImageGrant = { url: string; width?: number | undefined; height?: number | undefined };
type Identity = ProjectIssueAssetUrlInput["identity"];
const batches = new Map<
  string,
  Array<{ path: string; resolve: (value: ImageGrant) => void; reject: (error: unknown) => void }>
>();
function issueImage(identity: Identity, path: string): Promise<ImageGrant> {
  const key = JSON.stringify(identity);
  return new Promise((resolve, reject) => {
    const batch = batches.get(key);
    if (batch) {
      batch.push({ path, resolve, reject });
      return;
    }
    const pending = [{ path, resolve, reject }];
    batches.set(key, pending);
    queueMicrotask(async () => {
      batches.delete(key);
      try {
        const api = readNativeApi();
        if (!api) throw new Error("Disconnected");
        for (let offset = 0; offset < pending.length; offset += 100) {
          const entries = pending.slice(offset, offset + 100);
          const urls = await api.projects.issueAssetUrl({
            identity,
            files: entries.map((entry) => ({ relativePath: entry.path, grant: "file" })),
          });
          entries.forEach((entry, index) => {
            if (urls[index])
              entry.resolve({ ...urls[index], url: `${getServerHttpOrigin()}${urls[index].url}` });
            else entry.reject(new Error("Image unavailable"));
          });
        }
      } catch (error) {
        pending.forEach((entry) => entry.reject(error));
      }
    });
  });
}
export function ChatAssetImage({
  src,
  alt,
  cwd,
}: {
  src: string;
  alt: string;
  cwd: string | undefined;
}) {
  const { settings } = useAppSettings();
  const documentContext = useContext(AssetDocumentContext);
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [gallery, setGallery] = useState<AssetGalleryState | null>(null);
  useEffect(() => {
    if (!anchor.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, []);
  const remote = /^https:\/\//iu.test(src);
  let target = visible && !remote ? resolveChatAssetTarget(src, cwd, projects, threads) : undefined;
  if (visible && !remote && documentContext && !/^(?:[a-z]+:|[\\/])/iu.test(src)) {
    try {
      const documentUrl = new URL(documentContext.relativePath, "https://asset.invalid/");
      const resolved = new URL(src, documentUrl);
      if (resolved.origin === documentUrl.origin)
        target = {
          identity: documentContext.identity,
          path: decodeURIComponent(resolved.pathname.slice(1)),
        };
    } catch {
      /* Invalid relative media stays unavailable. */
    }
  }
  const grant = useQuery({
    queryKey: ["chat-asset", target?.identity, target?.path],
    queryFn: () => issueImage(target!.identity, target!.path),
    enabled: visible && !!target,
    staleTime: 25 * 60 * 1000,
    refetchInterval: visible ? 25 * 60 * 1000 : false,
  });
  const url = remote ? (settings.loadRemoteImagesInChat ? src : undefined) : grant.data?.url;
  return (
    <span ref={anchor} className="inline-block min-h-12 min-w-24 max-w-full">
      {visible && url ? (
        <button
          type="button"
          aria-label={`Preview ${alt || "image"}`}
          onClick={() => {
            const container = anchor.current?.closest(".chat-markdown");
            const images = container
              ? Array.from(
                  container.querySelectorAll<HTMLImageElement>("img[data-chat-asset]"),
                ).map((image) => ({ src: image.src, name: image.alt }))
              : [{ src: url, name: alt }];
            setGallery({
              images,
              index: Math.max(
                0,
                images.findIndex((image) => image.src === url),
              ),
            });
          }}
        >
          <img
            data-chat-asset
            src={url}
            alt={alt}
            width={grant.data?.width}
            height={grant.data?.height}
            style={
              grant.data?.width && grant.data.height
                ? { aspectRatio: `${grant.data.width}/${grant.data.height}` }
                : undefined
            }
            loading="lazy"
            referrerPolicy="no-referrer"
            className="max-h-96 max-w-full rounded object-contain"
          />
        </button>
      ) : (
        <span className="text-muted-foreground">
          {alt || "Image"}
          {remote && !settings.loadRemoteImagesInChat
            ? " (remote images disabled)"
            : grant.isError
              ? " (unavailable)"
              : ""}
        </span>
      )}
      {gallery && (
        <AssetImageGallery
          gallery={gallery}
          onChange={setGallery}
          onClose={() => setGallery(null)}
        />
      )}
    </span>
  );
}
