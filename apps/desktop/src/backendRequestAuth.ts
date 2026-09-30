import { isPrivateHttpPath } from "@t3tools/shared/backendPaths";

export const DESKTOP_BACKEND_HOST = "127.0.0.1";
export const DESKTOP_BACKEND_REQUEST_FILTER = `http://${DESKTOP_BACKEND_HOST}/*`;

export interface DesktopBackendRequestAuthInput {
  readonly url: string;
  readonly initiator?: DesktopBackendRequestInitiator;
  readonly backendPort: number;
  readonly authToken: string;
  readonly requestHeaders: Record<string, string>;
}

/** Populated only by main from Electron's request/frame identity, never renderer input. */
export interface DesktopBackendRequestInitiator {
  readonly registeredRenderer: boolean;
  readonly mainFrame: boolean;
  readonly frameOrigin: string;
  readonly appOrigin: string;
}

export function shouldAuthorizeDesktopBackendRequest(
  initiator: DesktopBackendRequestInitiator | undefined,
): boolean {
  return (
    initiator !== undefined &&
    initiator.registeredRenderer &&
    initiator.mainFrame &&
    initiator.frameOrigin !== "null" &&
    initiator.frameOrigin.length > 0 &&
    initiator.frameOrigin === initiator.appOrigin
  );
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
      isPrivateHttpPath(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function authorizeDesktopBackendRequestHeaders(
  input: DesktopBackendRequestAuthInput,
): Record<string, string> {
  if (
    !shouldAuthorizeDesktopBackendRequest(input.initiator) ||
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
