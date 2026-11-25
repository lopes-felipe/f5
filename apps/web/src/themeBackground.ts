import { useCallback, useLayoutEffect, useRef } from "react";
import { getServerHttpOrigin } from "./lib/serverHttpOrigin";

/** Downloads through a signed URL and retains the last successful image on offline retries. */
export function useThemeBackground(path: string | undefined): void {
  const image = useRef<string | undefined>(undefined);
  const themePath = path?.split("?", 1)[0];
  const clearImage = useCallback(() => {
    document.documentElement.style.removeProperty("--theme-background-image");
    if (image.current) URL.revokeObjectURL(image.current);
    image.current = undefined;
  }, []);
  useLayoutEffect(() => clearImage, [clearImage, themePath]);
  useLayoutEffect(() => {
    if (!path?.startsWith("/api/theme-background/")) return;
    const root = document.documentElement;
    const url = new URL(path, getServerHttpOrigin()).href;
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const load = () => {
      clearTimeout(retryTimer);
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
          if (!response.ok) throw new Error("Wallpaper download failed.");
          const blob = await response.blob();
          if (
            request.signal.aborted ||
            blob.size > 16 * 1024 * 1024 ||
            !["image/png", "image/jpeg", "image/webp"].includes(blob.type)
          )
            return;
          clearImage();
          image.current = URL.createObjectURL(blob);
          root.style.setProperty("--theme-background-image", `url("${image.current}")`);
        })
        .catch(() => {
          if (!request.signal.aborted && retries < 4) {
            retryTimer = setTimeout(load, 1000 * 2 ** retries++);
          }
        });
    };
    const online = () => {
      retries = 0;
      load();
    };
    load();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [clearImage, path]);
}
