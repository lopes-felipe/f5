const PRIVATE_BACKEND_PATH_PREFIXES = ["/attachments/", "/api/"] as const;

export const DESKTOP_BACKEND_HOST = "127.0.0.1";
export const DESKTOP_BACKEND_REQUEST_FILTER = `http://${DESKTOP_BACKEND_HOST}/*`;

export interface DesktopBackendRequestAuthInput {
  readonly url: string;
  readonly backendPort: number;
  readonly authToken: string;
  readonly requestHeaders: Record<string, string>;
}

export function getDesktopBackendHttpOrigin(backendPort: number): string {
  return `http://${DESKTOP_BACKEND_HOST}:${backendPort}`;
}

export function getDesktopBackendWebSocketUrl(backendPort: number, authToken: string): string {
  const url = new URL(getDesktopBackendHttpOrigin(backendPort));
  url.protocol = "ws:";
  url.pathname = "/";
  url.searchParams.set("token", authToken);
  return url.toString();
}

function isPrivateDesktopBackendRequest(url: string, backendPort: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === getDesktopBackendHttpOrigin(backendPort) &&
      PRIVATE_BACKEND_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
    );
  } catch {
    return false;
  }
}

export function authorizeDesktopBackendRequestHeaders(
  input: DesktopBackendRequestAuthInput,
): Record<string, string> {
  if (
    input.authToken.length === 0 ||
    !isPrivateDesktopBackendRequest(input.url, input.backendPort)
  ) {
    return input.requestHeaders;
  }

  return {
    ...input.requestHeaders,
    Authorization: `Bearer ${input.authToken}`,
  };
}
