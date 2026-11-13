import { useQuery } from "@tanstack/react-query";
import { resolveChatAssetTarget } from "../lib/chatAssetTarget";
import { useStore } from "../store";
import { useThreadSummaries } from "../threadSelectors";
import { readNativeApi } from "../nativeApi";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";

/** Native controls become playable on loadedmetadata, including unknown-duration streams. */
export function ChatAssetAudio({ src, cwd }: { src: string; cwd: string | undefined }) {
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
  if (query.isError) return <span role="alert">Audio unavailable</span>;
  return (
    <span className="inline-flex max-w-full align-middle">
      <audio aria-label={src.split(/[\\/]/).at(-1)} src={query.data} controls preload="metadata" />
    </span>
  );
}
