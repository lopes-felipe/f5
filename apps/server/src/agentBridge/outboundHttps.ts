/**
 * Outbound HTTPS policy for Agent Bridge requests F5 makes to the internet
 * (client metadata documents now; webhook verification and delivery later).
 *
 * - https on port 443 only; no URL credentials or fragments
 * - DNS is resolved for every request and every answer must be public; F5
 *   connects to the validated address while TLS still verifies the hostname
 * - redirects fail and are never followed; proxy variables are ignored
 * - 10 s total timeout, 64 KiB response cap, 256 KiB request cap
 *
 * @module agentBridge/outboundHttps
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

export const OUTBOUND_TIMEOUT_MS = 10_000;
export const OUTBOUND_MAX_RESPONSE_BYTES = 64 * 1024;
export const OUTBOUND_MAX_REQUEST_BYTES = 256 * 1024;

export class OutboundPolicyError extends Error {
  constructor(
    readonly reason:
      | "invalid-url"
      | "non-public-address"
      | "dns-failed"
      | "redirect"
      | "timeout"
      | "too-large"
      | "network",
    message: string,
  ) {
    super(message);
    this.name = "OutboundPolicyError";
  }
}

// ── address classification ───────────────────────────────────────────

const ipv4ToNumber = (address: string): number =>
  address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // unspecified / "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return !IPV4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (ipv4ToNumber(base) & mask) >>> 0;
  });
}

/** Expands an IPv6 address into eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // A trailing dotted IPv4 becomes two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/u);
  if (dotted) {
    const value = ipv4ToNumber(dotted[1]!);
    text = `${text.slice(0, -dotted[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const parse = (part: string) =>
    part.length === 0 ? [] : part.split(":").map((g) => parseInt(g, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: tail === undefined ? 0 : missing }, () => 0),
    ...right,
  ];
  return groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff) ? null : groups;
}

function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const embeddedV4 = () =>
    `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) follow the IPv4 rules.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return isPublicIpv4(embeddedV4());
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return isPublicIpv4(embeddedV4());
  const first = groups[0]!;
  // Only global unicast (2000::/3) is public.
  if ((first & 0xe000) !== 0x2000) return false; // covers ::, ::1, fc00::/7, fe80::/10, ff00::/8
  if (first === 0x2001 && groups[1]! < 0x0200) return false; // 2001::/23 IETF assignments, Teredo
  if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4
  return true;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

// ── URL policy ────────────────────────────────────────────────────────

export function validateOutboundUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundPolicyError("invalid-url", "The URL is not valid.");
  }
  if (url.protocol !== "https:")
    throw new OutboundPolicyError("invalid-url", "Only https URLs are allowed.");
  if (url.port !== "" && url.port !== "443")
    throw new OutboundPolicyError("invalid-url", "Only port 443 is allowed.");
  if (url.username || url.password)
    throw new OutboundPolicyError("invalid-url", "URLs may not carry credentials.");
  if (url.hash) throw new OutboundPolicyError("invalid-url", "URLs may not carry a fragment.");
  return url;
}

export type OutboundResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

const defaultResolver: OutboundResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Resolves a hostname; every answer must be public (a mixed answer is rejected). */
export async function resolvePublicAddress(
  hostname: string,
  resolver: OutboundResolver = defaultResolver,
): Promise<{ readonly address: string; readonly family: number }> {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) {
    if (!isPublicAddress(bare))
      throw new OutboundPolicyError("non-public-address", "That address is not public.");
    return { address: bare, family: isIP(bare) };
  }
  let answers: ReadonlyArray<{ readonly address: string; readonly family: number }>;
  try {
    answers = await resolver(bare);
  } catch {
    throw new OutboundPolicyError("dns-failed", "The host name could not be resolved.");
  }
  if (answers.length === 0)
    throw new OutboundPolicyError("dns-failed", "The host name has no addresses.");
  if (answers.some((answer) => !isPublicAddress(answer.address)))
    throw new OutboundPolicyError(
      "non-public-address",
      "The host resolves to a non-public address.",
    );
  return answers[0]!;
}

// ── requests ──────────────────────────────────────────────────────────

export interface OutboundRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export interface OutboundResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export type OutboundHttps = (request: OutboundRequest) => Promise<OutboundResponse>;

export function makeOutboundHttps(
  options: {
    readonly resolver?: OutboundResolver;
    /** Replaces `https.request` in tests. */
    readonly request?: typeof https.request;
  } = {},
): OutboundHttps {
  const doRequest = options.request ?? https.request;
  return async (input) => {
    const url = validateOutboundUrl(input.url);
    const body = input.body ?? "";
    if (Buffer.byteLength(body, "utf8") > OUTBOUND_MAX_REQUEST_BYTES)
      throw new OutboundPolicyError("too-large", "The request body is too large.");
    const maxBytes = input.maxResponseBytes ?? OUTBOUND_MAX_RESPONSE_BYTES;
    const timeoutMs = input.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    // Resolution happens per request; earlier validations are never reused.
    const resolved = await resolvePublicAddress(url.hostname, options.resolver);
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if ((lookupOptions as { all?: boolean }).all)
        (callback as unknown as (error: null, addresses: unknown[]) => void)(null, [resolved]);
      else callback(null, resolved.address, resolved.family);
    };
    // A dedicated agent per request: no pooled socket outlives its validation.
    const agent = new https.Agent({ keepAlive: false, lookup });
    return await new Promise<OutboundResponse>((resolve, reject) => {
      const request = doRequest(
        {
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: input.method ?? "GET",
          agent,
          servername: isIP(url.hostname) ? undefined : url.hostname,
          headers: {
            host: url.host,
            ...input.headers,
            ...(input.method === "POST"
              ? { "content-length": String(Buffer.byteLength(body)) }
              : {}),
          },
          signal: deadline,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new OutboundPolicyError("redirect", "Redirects are not followed."));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              reject(new OutboundPolicyError("too-large", "The response is too large."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", (cause) =>
            reject(new OutboundPolicyError("network", cause.message)),
          );
        },
      );
      request.on("error", (cause) =>
        reject(
          deadline.aborted
            ? new OutboundPolicyError("timeout", "The request timed out.")
            : new OutboundPolicyError("network", cause.message),
        ),
      );
      if (input.method === "POST") request.write(body);
      request.end();
    }).finally(() => agent.destroy());
  };
}
