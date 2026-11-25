import { useLayoutEffect } from "react";
import { getServerHttpOrigin } from "./lib/serverHttpOrigin";

/** Downloads through a signed URL and retains the last successful image on offline retries. */
export function useThemeBackground(path: string | undefined, revision: unknown): void {
  useLayoutEffect(() => {
    if (!path?.startsWith("/api/theme-background/")) return;
    const root = document.documentElement;
    const url = new URL(path, getServerHttpOrigin()).href;
    let controller: AbortController | undefined;
    let imageUrl: string | undefined;
    const clearImage = () => {
      root.style.removeProperty("--theme-background-image");
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = undefined;
    };
    const load = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void fetch(url, { signal: request.signal, cache: "no-store" })
        .then(async (response) => {
          if (request.signal.aborted) return;
          if (response.status === 404) {
            clearImage();
            return;
          }
          if (!response.ok) return;
          const blob = await response.blob();
          if (
            request.signal.aborted ||
            blob.size > 16 * 1024 * 1024 ||
            !["image/png", "image/jpeg", "image/webp"].includes(blob.type)
          )
            return;
          clearImage();
          imageUrl = URL.createObjectURL(blob);
          root.style.setProperty("--theme-background-image", `url("${imageUrl}")`);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener("online", load);
    return () => {
      window.removeEventListener("online", load);
      controller?.abort();
      clearImage();
    };
  }, [path, revision]);
}
