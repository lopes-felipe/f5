/**
 * Standard Webhooks signing and the callback verification handshake for
 * Agent Bridge event delivery. Every request goes through the outbound HTTPS
 * policy.
 *
 * @module agentBridge/events/webhook
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { OutboundPolicyError, type OutboundHttps } from "../outboundHttps.ts";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const MAX_EVENT_BODY_BYTES = 256 * 1024;

/** Decodes a `whsec_` secret; its base64 must be 24–64 bytes. Null when malformed. */
export function decodeWebhookSecret(secret: string): Uint8Array | null {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) return null;
  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) return null;
  return bytes.length >= 24 && bytes.length <= 64 ? new Uint8Array(bytes) : null;
}

/** `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`, one per secret, space-separated. */
export function signWebhook(input: {
  readonly id: string;
  readonly timestamp: number;
  readonly body: string;
  readonly secrets: ReadonlyArray<Uint8Array>;
}): string {
  return input.secrets
    .map(
      (secret) =>
        `v1,${createHmac("sha256", secret).update(`${input.id}.${input.timestamp}.${input.body}`).digest("base64")}`,
    )
    .join(" ");
}

export interface WebhookAttempt {
  /** HTTP status, or null when the outcome is unknown (network error, timeout). */
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly body: string;
  readonly error: string | null;
}

export async function postWebhook(
  outbound: OutboundHttps,
  input: {
    readonly url: string;
    readonly id: string;
    readonly subscriptionId: string;
    readonly body: string;
    readonly secrets: ReadonlyArray<Uint8Array>;
    readonly now: number;
  },
): Promise<WebhookAttempt> {
  // A new timestamp and signature on every attempt; the body and id never change.
  const timestamp = Math.floor(input.now / 1000);
  try {
    const response = await outbound({
      url: input.url,
      method: "POST",
      body: input.body,
      headers: {
        "content-type": "application/json",
        "webhook-id": input.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook({
          id: input.id,
          timestamp,
          body: input.body,
          secrets: input.secrets,
        }),
        "x-mcp-subscription-id": input.subscriptionId,
      },
    });
    const retryAfter = response.headers["retry-after"];
    const retryAfterSeconds =
      typeof retryAfter === "string" && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : null;
    return { status: response.status, retryAfterSeconds, body: response.body, error: null };
  } catch (cause) {
    return {
      status: null,
      retryAfterSeconds: null,
      body: "",
      error: cause instanceof OutboundPolicyError ? cause.reason : "network",
    };
  }
}

/**
 * Verification handshake: F5 POSTs a signed `{"type":"verification","challenge"}`
 * and requires the challenge echoed back. Returns null on success or the reason.
 */
export async function verifyCallback(
  outbound: OutboundHttps,
  input: {
    readonly url: string;
    readonly subscriptionId: string;
    readonly secrets: ReadonlyArray<Uint8Array>;
    readonly now: number;
  },
): Promise<string | null> {
  const challenge = randomBytes(24).toString("base64url");
  const attempt = await postWebhook(outbound, {
    url: input.url,
    id: `verify_${randomBytes(12).toString("hex")}`,
    subscriptionId: input.subscriptionId,
    body: JSON.stringify({ type: "verification", challenge }),
    secrets: input.secrets,
    now: input.now,
  });
  if (attempt.status === null) return attempt.error ?? "unreachable";
  if (attempt.status < 200 || attempt.status >= 300) return `status-${attempt.status}`;
  let echoed: unknown;
  try {
    echoed = (JSON.parse(attempt.body) as { challenge?: unknown }).challenge;
  } catch {
    return "invalid-response";
  }
  if (typeof echoed !== "string") return "challenge-mismatch";
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(echoed);
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? null
    : "challenge-mismatch";
}
