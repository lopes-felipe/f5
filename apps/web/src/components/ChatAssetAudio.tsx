import { useQuery } from "@tanstack/react-query";
import { resolveChatAssetTarget } from "../lib/chatAssetTarget";
import { useStore } from "../store";
import { useThreadSummaries } from "../threadSelectors";
import { readNativeApi } from "../nativeApi";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
import type { ReactNode } from "react";

/** Native controls become playable on loadedmetadata, including unknown-duration streams. */
export function ChatAssetAudio({
  src,
  cwd,
  children,
}: {
  src: string;
  cwd: string | undefined;
  children: ReactNode;
}) {
  const projects = useStore((state) => state.projects);
  const threads = useThreadSummaries();
  const target = resolveChatAssetTarget(src, cwd, projects, threads);
  const query = useQuery({
    queryKey: ["chat-audio", target?.identity, target?.path],
    enabled: !!target,
    queryFn: async () => {
      const api = readNativeApi();
      if (!api || !target) throw new Error("Audio is unavailable");
      const [grant] = await api.projects.issueAssetUrl({
        identity: target.identity,
        files: [{ relativePath: target.path, grant: "file" }],
      });
      if (!grant) throw new Error("Audio is unavailable");
      return `${getServerHttpOrigin()}${grant.url}`;
    },
    staleTime: 25 * 60 * 1000,
  });
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2 align-middle">
      {children}
      {query.isError ? (
        <span role="alert">Audio unavailable</span>
      ) : (
        query.data && (
          <audio
            aria-label={src.split(/[\\/]/).at(-1)}
            src={query.data}
            controls
            preload="metadata"
          />
        )
      )}
    </span>
  );
}
