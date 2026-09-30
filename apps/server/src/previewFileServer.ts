import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { WorkspaceAssetAuthorizer, WorkspaceAssetIdentity } from "./WorkspaceAssetAuthorizer";
import { serveAsset } from "./assetHttp";

/** Separate loopback origin for explicit, active HTML previews. Never receives backend auth. */
export function makePreviewFileServer(authorizer: WorkspaceAssetAuthorizer) {
  const grants = new Map<
    string,
    { identity: WorkspaceAssetIdentity; directory: string; expiresAt: number }
  >();
  let listening: Promise<number> | undefined;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      const [handle, ...segments] = new URL(req.url ?? "/", "http://localhost").pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent);
      const grant = handle ? grants.get(handle) : undefined;
      if (!grant || grant.expiresAt <= Date.now()) {
        if (handle) grants.delete(handle);
        res.writeHead(404);
        res.end();
        return;
      }
      if (
        segments.length > 5 ||
        segments.some(
          (segment) =>
            !segment ||
            segment.startsWith(".") ||
            segment.includes("\0") ||
            segment.includes("/") ||
            segment.includes("\\"),
        ) ||
        !/\.(html?|css|js|mjs|json|png|jpg|jpeg|gif|webp|avif|svg|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg)$/iu.test(
          segments.at(-1) ?? "",
        )
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const reader =
        grant.identity.kind === "project"
          ? await authorizer.forProject(grant.identity.projectId)
          : grant.identity.kind === "thread"
            ? await authorizer.forThread(grant.identity.threadId)
            : await authorizer.forAttachments();
      const name = path.join(grant.directory, ...segments);
      const file = await reader.openFile(name);
      await serveAsset(req, res, file, name, { activePreview: true });
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return {
    issue: async (identity: WorkspaceAssetIdentity, relativePath: string) => {
      if (!/\.html?$/iu.test(relativePath))
        throw new Error("Active preview requires an HTML document.");
      const reader =
        identity.kind === "project"
          ? await authorizer.forProject(identity.projectId)
          : identity.kind === "thread"
            ? await authorizer.forThread(identity.threadId)
            : await authorizer.forAttachments();
      const file = await reader.openFile(relativePath);
      await file.close();
      if (!listening) {
        listening = new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            const address = server.address();
            if (!address || typeof address === "string")
              reject(new Error("Preview server unavailable"));
            else resolve(address.port);
          });
        });
      }
      const port = await listening;
      for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id);
      if (grants.size >= 64) grants.delete(grants.keys().next().value!);
      const handle = randomBytes(24).toString("base64url");
      grants.set(handle, {
        identity,
        directory: path.dirname(relativePath),
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      return `http://127.0.0.1:${port}/${handle}/${encodeURIComponent(path.basename(relativePath))}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        grants.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
