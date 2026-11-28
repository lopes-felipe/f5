// Vendored from pingdotgg/t3code@d898612a03 apps/mobile/src/features/connection/pairing.ts
export interface PairingAddress {
  readonly origins: readonly string[];
  readonly code: string;
  readonly serverId?: string;
  readonly profileName?: string;
}

export interface PairedServer {
  readonly origins: readonly string[];
  readonly serverId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly profileName: string;
  readonly deviceName: string;
}

export function parseTailnetOrigin(raw: string): string {
  const value = raw.trim();
  const url = new URL(value.includes("://") ? value : "http://" + value);
  const host = url.hostname.toLowerCase();
  const [first, second, ...rest] = host.split(".");
  const ipv4 =
    first === "100" &&
    Number(second) >= 64 &&
    Number(second) <= 127 &&
    rest.length === 2 &&
    rest.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
  const ipv6 = /^\[fd7a:115c:a1e0:[0-9a-f:]+\]$/.test(host);
  const dns = /^(?:[a-z0-9-]+\.)+ts\.net$/.test(host);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (!ipv4 && !ipv6 && !dns) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Enter the Tailscale origin shown in Phone access.");
  }
  return url.origin;
}

export function manualPairing(origin: string, text: string): PairingAddress {
  const code = text.trim().toUpperCase();
  if (!/^[A-Z2-7]{10}$/.test(code)) throw new Error("Enter the 10-character pairing code.");
  return { origins: [parseTailnetOrigin(origin)], code };
}

export function parsePairingUrl(payload: string): PairingAddress {
  try {
    const url = new URL(payload.trim());
    const params = url.searchParams;
    if (
      url.protocol !== "f5:" ||
      url.hostname !== "pair" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      params.get("v") !== "1"
    ) {
      throw new Error();
    }
    for (const name of ["v", "o", "o2", "c", "s", "n"]) {
      if (params.getAll(name).length > 1) throw new Error();
    }
    const parsed = manualPairing(params.get("o") ?? "", params.get("c") ?? "");
    const fallback = params.get("o2");
    const serverId = params.get("s");
    const profileName = params.get("n");
    if (!serverId || !/^[A-Za-z0-9_-]{32}$/.test(serverId)) throw new Error();
    return {
      ...parsed,
      origins: [
        ...new Set([...parsed.origins, ...(fallback ? [parseTailnetOrigin(fallback)] : [])]),
      ],
      serverId,
      ...(profileName ? { profileName } : {}),
    };
  } catch {
    throw new Error("This QR code is not a valid F5 pairing code.");
  }
}
