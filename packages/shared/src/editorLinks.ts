const LOCAL_EDITOR_PROTOCOLS = new Set(["cursor:", "vscode:", "vscode-insiders:"]);

export function parseLocalEditorFileUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      !LOCAL_EDITOR_PROTOCOLS.has(url.protocol) ||
      url.host !== "file" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const path = decodeURIComponent(url.pathname);
    if (
      path.length < 2 ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\p{Cc}]/u.test(path)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
