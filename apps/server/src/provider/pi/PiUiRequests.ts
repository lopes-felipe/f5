import type { ProviderApprovalDecision, UserInputQuestion } from "@t3tools/contracts";
import { piRecordNumber, piRecordString, type PiRpcRecord } from "./PiProtocol.ts";

export interface PendingPiUiRequest {
  readonly requestId: string;
  readonly generation: string;
  readonly nativeId: string;
  readonly turnId: string | undefined;
  readonly method: "confirm" | "select" | "input" | "editor";
  readonly title: string;
  readonly message: string;
  readonly expiresAt: number | null;
  readonly question: UserInputQuestion | undefined;
  readonly prefill: string | undefined;
  readonly optionValues: ReadonlyMap<string, string>;
}
export type PiUiAdmission =
  | { readonly type: "ignored" }
  | { readonly type: "opened"; readonly request: PendingPiUiRequest }
  | { readonly type: "cancelled"; readonly record: PiRpcRecord }
  | { readonly type: "protocol-error" };

/** One live session generation owns every native dialog. No approval survives its owning request. */
export class PiUiRequests {
  readonly #pending = new Map<string, PendingPiUiRequest>();
  constructor(readonly generation: string) {}
  get size() {
    return this.#pending.size;
  }
  list(): readonly PendingPiUiRequest[] {
    return [...this.#pending.values()];
  }
  get(requestId: string): PendingPiUiRequest | undefined {
    return this.#pending.get(requestId);
  }
  #cancel(nativeId: string): PiRpcRecord {
    return { type: "extension_ui_response", id: nativeId, cancelled: true };
  }

  open(event: PiRpcRecord, requestId: string, now: number, turnId?: string): PiUiAdmission {
    const method = piRecordString(event, "method");
    if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor")
      return { type: "ignored" };
    const nativeId = piRecordString(event, "id");
    if (!nativeId || nativeId.length > 1024 || !Number.isFinite(now))
      return { type: "protocol-error" };
    if (
      this.#pending.has(requestId) ||
      [...this.#pending.values()].some((request) => request.nativeId === nativeId)
    )
      return { type: "protocol-error" };
    const title = piRecordString(event, "title") || method;
    const message =
      piRecordString(event, "message") ?? piRecordString(event, "placeholder") ?? title;
    const prefill = method === "editor" ? (piRecordString(event, "prefill") ?? "") : undefined;
    const timeout = piRecordNumber(event, "timeout");
    const options = event.options;
    if (
      this.#pending.size >= 64 ||
      title.length > 512 ||
      message.length > 64 * 1024 ||
      (prefill?.length ?? 0) > 64 * 1024 ||
      (event.timeout !== undefined && timeout === undefined) ||
      (method === "select" &&
        (!Array.isArray(options) ||
          options.length > 100 ||
          options.some((option) => typeof option !== "string" || option.length > 4096)))
    )
      return { type: "cancelled", record: this.#cancel(nativeId) };
    const expiresAt = timeout === undefined || timeout === 0 ? null : now + Math.max(0, timeout);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now))
      return { type: "cancelled", record: this.#cancel(nativeId) };
    const optionValues = new Map<string, string>();
    if (method === "select")
      for (const [index, value] of (options as string[]).entries())
        optionValues.set(`${index + 1}. ${value || "Empty value"}`, value);
    const question =
      method === "confirm"
        ? undefined
        : ({
            id: requestId,
            header: title.trim() || method,
            question: message.trim() || title.trim() || method,
            ...(prefill !== undefined ? { initialAnswer: prefill, optional: true } : {}),
            options: [...optionValues].map(([label, value]) => ({
              label,
              description: value.trim() || "Send an empty value.",
            })),
          } satisfies UserInputQuestion);
    const request: PendingPiUiRequest = {
      requestId,
      generation: this.generation,
      nativeId,
      turnId,
      method,
      title,
      message,
      expiresAt,
      question,
      prefill,
      optionValues,
    };
    this.#pending.set(requestId, request);
    return { type: "opened", request };
  }

  expire(request: PendingPiUiRequest, now: number): PiRpcRecord | undefined {
    if (
      this.#pending.get(request.requestId) !== request ||
      request.expiresAt === null ||
      now < request.expiresAt
    )
      return undefined;
    this.#pending.delete(request.requestId);
    return this.#cancel(request.nativeId);
  }
  answer(input: {
    readonly requestId: string;
    readonly generation: string;
    readonly now: number;
    readonly decision?: ProviderApprovalDecision;
    readonly answer?: unknown;
  }): { readonly record: PiRpcRecord; readonly expired: boolean } | null {
    const request = this.#pending.get(input.requestId);
    if (!request || input.generation !== request.generation || !Number.isFinite(input.now))
      return null;
    this.#pending.delete(input.requestId);
    if (request.expiresAt !== null && input.now >= request.expiresAt)
      return { record: this.#cancel(request.nativeId), expired: true };
    let response: PiRpcRecord = { cancelled: true };
    if (request.method === "confirm") {
      if (
        input.decision === "accept" ||
        input.decision === "acceptForSession" ||
        input.decision === "acceptAlways"
      )
        response = { confirmed: true };
      else if (input.decision === "decline") response = { confirmed: false };
    } else {
      let value = input.answer;
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        value = (value as Record<string, unknown>).answers;
      if (Array.isArray(value))
        value =
          value.length === 1
            ? value[0]
            : value.length === 0 && request.method === "editor"
              ? ""
              : undefined;
      if (typeof value === "string" && value.length <= 64 * 1024) {
        if (request.method === "select") {
          const selected = request.optionValues.get(value);
          if (selected !== undefined) response = { value: selected };
        } else response = { value };
      }
    }
    return {
      record: { type: "extension_ui_response", id: request.nativeId, ...response },
      expired: false,
    };
  }
  cancelTurn(turnId: string): readonly PiRpcRecord[] {
    const records: PiRpcRecord[] = [];
    for (const request of this.#pending.values())
      if (request.turnId === turnId) {
        this.#pending.delete(request.requestId);
        records.push(this.#cancel(request.nativeId));
      }
    return records;
  }
  cancelAll(): readonly PiRpcRecord[] {
    const records = [...this.#pending.values()].map((request) => this.#cancel(request.nativeId));
    this.#pending.clear();
    return records;
  }
}
