/**
 * MspSessionRuntime — one `muse serve` host and its MSP connection.
 *
 * Owns the handshake (fingerprint pin, durability), the F5-side request gate
 * (in-flight cap, per-request timeouts), delivery-certainty classification,
 * and the permission read-back every start and resume must pass. Sessions,
 * revisions and gap splice-fill stay in the SDK's `MuseClient`/`SessionFold`;
 * F5 writes no fold of its own.
 *
 * @module provider/msp/MspSessionRuntime
 */
import {
  checkServedFingerprint,
  Connection,
  createUuidV7Mint,
  MspError,
  MuseClient,
  ProtocolError,
  readSessionDurability,
  type ConnectionOptions,
  type DuplexTransport,
  type FingerprintWarning,
  type NotificationHandler,
  type SessionDurabilityProfile,
} from "@muse-code/sdk";
import type { InitializeResult, Notification } from "@muse-code/sdk/dist/src/msp.js";
import { Data } from "effect";
import {
  MUSE_APPROVAL_MODE_BY_RUNTIME_MODE,
  MUSE_EXPECTED_SCHEMA_FINGERPRINT,
} from "@t3tools/shared/museProtocolManifest";

import { MSP_FRAME_LIMIT_BYTES, MspTransportClosedError } from "./MspTransport.ts";

export const MSP_MAX_IN_FLIGHT = 256;
export const MSP_REQUEST_TIMEOUT_MS = 30_000;
export const MSP_TURN_START_TIMEOUT_MS = 60_000;

export type MuseRuntimeMode = keyof typeof MUSE_APPROVAL_MODE_BY_RUNTIME_MODE;
export type MuseApprovalMode = (typeof MUSE_APPROVAL_MODE_BY_RUNTIME_MODE)[MuseRuntimeMode];

export function isMuseRuntimeMode(value: string): value is MuseRuntimeMode {
  return value === "auto-accept-edits" || value === "full-access";
}

/** A failed short-lived Muse Code host interaction (probe, text generation). */
export class MuseCliError extends Data.TaggedError("MuseCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A failure F5 raised locally, before or instead of a server answer. */
export class MspLocalError extends Error {
  constructor(
    readonly kind: "overloaded" | "timeout",
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = "MspLocalError";
  }
}

export type MspDeliveryCertainty = "not_sent" | "delivered" | "ambiguous";

export interface MspDeliveryClassification {
  readonly certainty: MspDeliveryCertainty;
  readonly retryable: boolean;
}

const COMMAND_REJECTED_CODE = -32030;
const NOT_SENT_RETRYABLE_KINDS = new Set(["overloaded", "backpressured"]);
const NOT_SENT_FINAL_KINDS = new Set(["commandRejected", "invalidParams", "inputTooLarge"]);

/**
 * Whether a failed command reached the host. Only an error F5 can prove was
 * never admitted is `not_sent`; a timeout or host death after the frame was
 * written stays ambiguous so the caller replays with the same native id.
 */
export function classifyMspDelivery(error: unknown): MspDeliveryClassification {
  if (error instanceof MspLocalError) {
    return error.kind === "overloaded"
      ? { certainty: "not_sent", retryable: true }
      : { certainty: "ambiguous", retryable: false };
  }
  if (error instanceof MspTransportClosedError) {
    return { certainty: "not_sent", retryable: true };
  }
  if (error instanceof ProtocolError) {
    // The connection rejects writes once finished: nothing left this process.
    return error.message === "connection is closed"
      ? { certainty: "not_sent", retryable: true }
      : { certainty: "ambiguous", retryable: false };
  }
  if (error instanceof MspError) {
    if (NOT_SENT_RETRYABLE_KINDS.has(error.kind)) return { certainty: "not_sent", retryable: true };
    if (error.code === COMMAND_REJECTED_CODE || NOT_SENT_FINAL_KINDS.has(error.kind)) {
      return { certainty: "not_sent", retryable: false };
    }
    // Any other server-authored error is an answer: the command was admitted
    // far enough to be judged.
    return { certainty: "delivered", retryable: false };
  }
  return { certainty: "ambiguous", retryable: false };
}

export function mspErrorKind(error: unknown): string | undefined {
  return error instanceof MspError ? error.kind : undefined;
}

export function describeMspError(error: unknown): string {
  if (error instanceof MspError) return `${error.message} (${error.kind})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `Connection` whose single notification slot fans out: the SDK client's
 * router runs first (so the fold is current), then every F5 listener.
 */
export class TappedConnection extends Connection {
  readonly #listeners = new Set<NotificationHandler>();
  #primary: NotificationHandler | undefined;

  constructor(transport: DuplexTransport, options?: ConnectionOptions) {
    super(transport, options);
    super.onNotification((notification) => {
      this.#primary?.(notification);
      for (const listener of this.#listeners) {
        try {
          listener(notification);
        } catch {
          // A listener fault must not stop delivery to the others.
        }
      }
    });
  }

  override onNotification(handler: NotificationHandler): void {
    this.#primary = handler;
  }

  addListener(listener: NotificationHandler): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** In-flight cap and timeouts for every request F5 originates. */
export class MspRequestGate {
  #inFlight = 0;

  constructor(readonly limit: number = MSP_MAX_IN_FLIGHT) {}

  get inFlight(): number {
    return this.#inFlight;
  }

  async run<T>(method: string, timeoutMs: number, send: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.limit) {
      throw new MspLocalError(
        "overloaded",
        method,
        `Muse Code has ${this.limit} requests in flight; ${method} was not sent.`,
      );
    }
    this.#inFlight += 1;
    let sent: Promise<T>;
    try {
      sent = send();
    } catch (error) {
      this.#inFlight -= 1;
      throw error;
    }
    // The slot frees when the host answers, not when F5 stops waiting: a timed
    // out request is still outstanding on the wire.
    sent.then(
      () => (this.#inFlight -= 1),
      () => (this.#inFlight -= 1),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        sent,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MspLocalError("timeout", method, `${method} timed out after ${timeoutMs} ms.`),
              ),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A command-id source that hands out pinned ids before minting fresh ones. */
export class PinnableCommandIdMint {
  readonly #mint = createUuidV7Mint();
  #pinned: string | undefined;

  pin(commandId: string): void {
    this.#pinned = commandId;
  }

  readonly next = (): string => {
    const pinned = this.#pinned;
    this.#pinned = undefined;
    return pinned ?? this.#mint();
  };

  readonly fresh = (): string => this.#mint();
}

export interface MspHost {
  readonly connection: TappedConnection;
  readonly client: MuseClient;
  readonly initializeResult: InitializeResult;
  readonly fingerprintWarning: FingerprintWarning | undefined;
  readonly durability: SessionDurabilityProfile;
  readonly gate: MspRequestGate;
  readonly commandIds: PinnableCommandIdMint;
  readonly request: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  readonly command: (
    method: string,
    params: Record<string, unknown>,
    options?: { readonly commandId?: string; readonly timeoutMs?: number },
  ) => Promise<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

/** Handshake on an open transport: initialize, pin check, durability, client. */
export async function openMspHost(input: {
  readonly transport: DuplexTransport;
  readonly clientVersion: string;
  readonly onProtocolError?: (error: ProtocolError) => void;
}): Promise<MspHost> {
  const commandIds = new PinnableCommandIdMint();
  const connection = new TappedConnection(input.transport, {
    frameLimitBytes: MSP_FRAME_LIMIT_BYTES,
    mintCommandId: commandIds.next,
  });
  if (input.onProtocolError) connection.onProtocolError(input.onProtocolError);
  const gate = new MspRequestGate();
  const initializeResult = (await gate.run("initialize", MSP_REQUEST_TIMEOUT_MS, () =>
    connection.request("initialize", {
      clientInfo: { name: "F5", title: "F5", version: input.clientVersion },
    }),
  )) as unknown as InitializeResult;
  if (typeof initializeResult.schema?.fingerprint !== "string") {
    throw new ProtocolError("initialize result has no schema fingerprint");
  }
  connection.notify("initialized");
  await connection.flush();
  const fingerprintWarning = checkServedFingerprint(
    initializeResult.schema.fingerprint,
    MUSE_EXPECTED_SCHEMA_FINGERPRINT,
  );
  const durability = readSessionDurability(initializeResult);
  const client = new MuseClient(connection, { durability });
  return {
    connection,
    client,
    initializeResult,
    fingerprintWarning,
    durability,
    gate,
    commandIds,
    request: (method, params, timeoutMs = MSP_REQUEST_TIMEOUT_MS) =>
      gate.run(method, timeoutMs, () => connection.request(method, params)),
    command: (method, params, options) =>
      gate.run(method, options?.timeoutMs ?? MSP_REQUEST_TIMEOUT_MS, () =>
        connection.command(method, params, {
          commandId: options?.commandId ?? commandIds.fresh(),
        }),
      ),
    close: () => client.close(),
  };
}

export type PermissionVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The read-back every start and resume must pass. MSP 1.4 reports the
 * effective approval mode and host sandbox availability; the approval judge
 * is pinned off by the launch arguments.
 */
export function verifyMusePermissionState(input: {
  readonly runtimeMode: MuseRuntimeMode;
  readonly initializeResult: InitializeResult;
  readonly effectiveApprovalMode: string | undefined;
}): PermissionVerification {
  const expected = MUSE_APPROVAL_MODE_BY_RUNTIME_MODE[input.runtimeMode];
  if (input.initializeResult.sandboxAvailability !== "available") {
    return {
      ok: false,
      reason: `Muse Code reports its sandbox is ${input.initializeResult.sandboxAvailability ?? "unreported"}${
        input.initializeResult.sandboxUnavailableReason
          ? ` (${input.initializeResult.sandboxUnavailableReason})`
          : ""
      }. F5 only runs Muse Code with its sandbox on.`,
    };
  }
  if (input.effectiveApprovalMode !== expected) {
    return {
      ok: false,
      reason: `Muse Code applied approval mode '${input.effectiveApprovalMode ?? "unknown"}' instead of '${expected}' for ${input.runtimeMode}.`,
    };
  }
  return { ok: true };
}

export function notificationParams(notification: Notification): Record<string, unknown> {
  return notification.params ?? {};
}
