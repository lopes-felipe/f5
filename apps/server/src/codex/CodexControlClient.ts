import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { CODEX_MAX_INCOMING_MESSAGE_BYTES, ProviderLineReader } from "./lineReader.ts";

import { type CodexMcpServerEntry, type McpServerStartupStatus } from "@t3tools/contracts";
import { CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS } from "@t3tools/shared/codexOAuthTiming";
import {
  assertSupportedCodexCliVersion,
  buildCodexInitializeParams,
  killChildTree,
} from "../codexAppServerManager.ts";
import { readCodexModelPages } from "./readCodexModelPages.ts";
import {
  createJsonRpcStdinWriter,
  JsonRpcDeliveryError,
  jsonRpcWriteLane,
  type JsonRpcWriteOptions,
  type JsonRpcStdinWriter,
} from "./JsonRpcStdinWriter.ts";
import { buildCodexAppServerCommand } from "../provider/codexLaunchArgs.ts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";
import { resolveCodexHome } from "../os-jank.ts";
import { resolveInvocation } from "../spawn/resolveCommand.ts";
import { createLogger } from "../logger.ts";

const codexControlLogger = createLogger("codexControlClient");

interface PendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  wasWritten?: boolean;
  cancelWrite?: () => void;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexControlEnvironmentConfig {
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly mcpServers?: Record<string, CodexMcpServerEntry>;
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
}

export interface CodexControlCapabilities {
  readonly configRead: boolean;
  readonly listMcpServerStatus: boolean;
}

export interface CodexControlConfigLayerMetadata {
  readonly name?: unknown;
  readonly version?: string;
}

export interface CodexControlConfigLayer {
  readonly name?: unknown;
  readonly version?: string;
  readonly config?: unknown;
  readonly disabledReason?: string | null;
}

export interface CodexControlConfigReadResult {
  readonly config: Record<string, unknown>;
  readonly origins?: Record<string, CodexControlConfigLayerMetadata>;
  readonly layers?: ReadonlyArray<CodexControlConfigLayer> | null;
}

export interface CodexControlConfigWriteResult {
  readonly status?: string;
  readonly version: string;
  readonly filePath?: string;
  readonly overriddenMetadata?: unknown;
}

export interface CodexControlConfigEdit {
  readonly keyPath: string;
  readonly value: unknown;
  readonly mergeStrategy: "replace" | "upsert";
}

export interface CodexControlConfigBatchWriteInput {
  readonly edits: ReadonlyArray<CodexControlConfigEdit>;
  readonly filePath?: string;
  readonly expectedVersion?: string;
  readonly reloadUserConfig?: boolean;
}

export interface CodexControlMcpServerStatus {
  readonly name: string;
  readonly tools?: Record<string, unknown>;
  readonly resources?: ReadonlyArray<unknown>;
  readonly resourceTemplates?: ReadonlyArray<unknown>;
  readonly authStatus?: string;
  readonly startupStatus?: McpServerStartupStatus;
  readonly error?: string;
}

export interface CodexControlListMcpServerStatusResult {
  readonly data: ReadonlyArray<CodexControlMcpServerStatus>;
  readonly nextCursor: string | null;
}

export interface CodexControlStartOauthLoginInput {
  readonly name: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly timeoutSecs?: number;
}

export interface CodexControlStartOauthLoginResult {
  readonly authorizationUrl: string;
}

export interface CodexControlNotification {
  readonly method: string;
  readonly params?: unknown;
}

export class CodexControlRequestError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(input: {
    readonly method: string;
    readonly code?: number;
    readonly message: string;
    readonly data?: unknown;
  }) {
    super(`${input.method} failed: ${input.message}`);
    this.name = "CodexControlRequestError";
    if (input.code !== undefined) {
      this.code = input.code;
    }
    if ("data" in input) {
      this.data = input.data;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isObject(value) && (typeof value.id === "string" || typeof value.id === "number");
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asMcpServerStartupStatus(value: unknown): McpServerStartupStatus | undefined {
  switch (value) {
    case "starting":
    case "ready":
    case "failed":
    case "needs-auth":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function isMethodNotFoundError(error: unknown): boolean {
  return (
    (error instanceof CodexControlRequestError && error.code === -32601) ||
    (error instanceof Error && /method not found/i.test(error.message))
  );
}

export class CodexControlClient extends EventEmitter<{
  notification: [CodexControlNotification];
  closed: [Error];
  protocolError: [Error];
}> {
  capabilities: CodexControlCapabilities;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: ProviderLineReader;
  private readonly writer: JsonRpcStdinWriter;
  private readonly pending = new Map<string, PendingRequest>();
  private mcpObservationContext: object = {};
  getMcpObservationContext(): object {
    return this.mcpObservationContext;
  }
  private readonly mcpStartupStatuses = new Map<
    string,
    {
      readonly name: string;
      readonly startupStatus: McpServerStartupStatus;
      readonly error?: string;
    }
  >();
  private nextRequestId = 1;
  private closed = false;
  private reportedProtocolError = false;
  private cleanupProcessListeners: () => void = () => {};
  private removeAbortListener: (() => void) | undefined;

  private constructor(
    private readonly environment: CodexControlEnvironmentConfig,
    child: ChildProcessWithoutNullStreams,
    output: ProviderLineReader,
    writer: JsonRpcStdinWriter,
    capabilities: CodexControlCapabilities,
  ) {
    super();
    this.child = child;
    this.output = output;
    this.writer = writer;
    this.capabilities = capabilities;
    this.attachProcessListeners();
  }

  static async create(
    environment: CodexControlEnvironmentConfig,
    signal?: AbortSignal,
  ): Promise<CodexControlClient> {
    signal?.throwIfAborted();
    const binaryPath = environment.binaryPath ?? "codex";
    const codexHomePath = resolveCodexHome({ homePath: environment.homePath });
    await assertSupportedCodexCliVersion({
      processEnvironment: environment.processEnvironment ?? process.env,
      binaryPath,
      cwd: environment.cwd,
      ...(signal ? { signal } : {}),
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
    });
    const childEnvironment = buildProviderChildProcessEnv(
      environment.processEnvironment ?? process.env,
      codexHomePath ? { CODEX_HOME: codexHomePath } : undefined,
    );
    const appServerCommand = buildCodexAppServerCommand({
      ...(environment.launchArgs ? { providerLaunchArgs: environment.launchArgs } : {}),
      environment: childEnvironment,
      mcpServers: environment.mcpServers ?? {},
      ...(environment.mcpOAuthCallbackPort
        ? { mcpOAuthCallbackPort: environment.mcpOAuthCallbackPort }
        : {}),
      ...(environment.mcpOAuthCallbackUrl
        ? { mcpOAuthCallbackUrl: environment.mcpOAuthCallbackUrl }
        : {}),
    });
    if (appServerCommand.dropped.length > 0) {
      codexControlLogger.warn("Ignored reserved Codex launch arguments", {
        droppedTokenCount: appServerCommand.dropped.length,
      });
    }
    const invocation = resolveInvocation(binaryPath, appServerCommand.argv, childEnvironment, {
      cwd: environment.cwd,
    });

    const child = spawn(invocation.file, [...invocation.args], {
      cwd: environment.cwd,
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    const output = new ProviderLineReader(child.stdout, CODEX_MAX_INCOMING_MESSAGE_BYTES);
    const writer = createJsonRpcStdinWriter({
      stdin: child.stdin,
      closedMessage: "Codex control client is closed.",
    });

    const client = new CodexControlClient(environment, child, output, writer, {
      configRead: false,
      listMcpServerStatus: false,
    });

    if (signal) {
      const abort = () => client.close();
      signal.addEventListener("abort", abort, { once: true });
      client.removeAbortListener = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) client.close();
    }
    try {
      await client.sendRequest("initialize", buildCodexInitializeParams());
      await client.writeMessage({
        method: "initialized",
      });
      client.capabilities = await client.probeCapabilities();
      return client;
    } catch (error) {
      await client.closeAndWait();
      throw error;
    }
  }

  private async probeCapabilities(): Promise<CodexControlCapabilities> {
    return {
      configRead: await this.probeMethod("config/read", { includeLayers: true }),
      listMcpServerStatus: await this.probeMethod("mcpServerStatus/list", { limit: 1 }),
    };
  }

  private async probeMethod(method: string, params: unknown): Promise<boolean> {
    try {
      await this.sendRequest(method, params);
      return true;
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  private attachProcessListeners(): void {
    const onLine = (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (!this.reportedProtocolError) {
          this.reportedProtocolError = true;
          codexControlLogger.warn("Malformed Codex control JSON line; continuing session");
        }
        this.emit("protocolError", new Error("Malformed Codex control JSON line."));
        return;
      }

      if (isJsonRpcResponse(parsed)) {
        this.handleResponse(parsed);
        return;
      }

      if (isJsonRpcNotification(parsed)) {
        this.recordMcpStartupStatus(parsed);
        this.emit("notification", {
          method: parsed.method,
          params: parsed.params,
        });
      }
    };
    this.output.on("line", onLine);

    const handleExit = (cause: Error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.cleanupProcessListeners();
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(
          new JsonRpcDeliveryError(
            cause.message,
            pending.wasWritten === false ? "not_sent" : "unknown",
          ),
        );
        pending.cancelWrite?.();
      }
      this.pending.clear();
      this.output.close();
      this.writer.close(cause);
      this.emit("closed", cause);
    };

    const onError = (error: Error) => handleExit(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      handleExit(
        new Error(
          `codex control client exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    // The reader stopped at the cap and cannot resynchronize mid-message, so the client ends.
    const onOverflow = () => {
      handleExit(
        new Error(
          `codex app-server sent a message larger than ${CODEX_MAX_INCOMING_MESSAGE_BYTES} bytes; the control client was closed.`,
        ),
      );
      if (!this.child.killed) killChildTree(this.child);
    };
    this.child.once("error", onError);
    this.child.once("exit", onExit);
    this.output.once("overflow", onOverflow);
    this.cleanupProcessListeners = () => {
      this.output.off("line", onLine);
      this.output.off("overflow", onOverflow);
      this.child.off("error", onError);
      this.child.off("exit", onExit);
    };
  }

  private recordMcpStartupStatus(notification: JsonRpcNotification): void {
    if (notification.method !== "mcpServer/startupStatus/updated") {
      return;
    }

    const params = isObject(notification.params) ? notification.params : undefined;
    const name = asTrimmedString(params?.name);
    const startupStatus = asMcpServerStartupStatus(params?.status);
    if (!name || !startupStatus) {
      return;
    }

    this.mcpStartupStatuses.set(name.trim(), {
      name,
      startupStatus,
      ...(asTrimmedString(params?.error) ? { error: asTrimmedString(params?.error)! } : {}),
    });
  }

  private handleResponse(response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(key);

    if (response.error?.message) {
      const requestError = new CodexControlRequestError({
        method: pending.method,
        message: response.error.message,
        ...(response.error.code !== undefined ? { code: response.error.code } : {}),
        ...(response.error.data !== undefined ? { data: response.error.data } : {}),
      });
      pending.reject(requestError);
      return;
    }

    pending.resolve(response.result);
  }

  private async writeMessage(message: unknown, options?: JsonRpcWriteOptions): Promise<void> {
    if (this.closed) {
      throw new Error("Codex control client is closed.");
    }
    await this.writer.write(message, { lane: jsonRpcWriteLane(message), ...options });
  }

  private async sendRequest<TResponse>(
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    if (this.closed) {
      throw new Error("Codex control client is closed.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return await new Promise<TResponse>((resolve, reject) => {
      const controller = new AbortController();
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as TResponse),
        reject,
        wasWritten: false,
        cancelWrite: () => controller.abort(),
        timeout: setTimeout(() => {
          this.pending.delete(String(id));
          controller.abort();
          reject(
            new JsonRpcDeliveryError(
              `Timed out waiting for ${method}.`,
              pending.wasWritten ? "unknown" : "not_sent",
            ),
          );
        }, timeoutMs),
      };
      this.pending.set(String(id), pending);
      void this.writeMessage(
        { id, method, params },
        {
          signal: controller.signal,
          deadline: Date.now() + timeoutMs,
          onWrite: () => {
            pending.wasWritten = true;
          },
        },
      ).catch((error) => {
        clearTimeout(pending.timeout);
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }

  async readConfig(): Promise<CodexControlConfigReadResult> {
    if (!this.capabilities.configRead) {
      throw new Error("Codex control config/read is unsupported.");
    }

    const result = await this.sendRequest<Record<string, unknown>>("config/read", {
      includeLayers: true,
    });
    const config = isObject(result.config) ? result.config : {};
    return {
      config,
      ...(isObject(result.origins)
        ? { origins: result.origins as Record<string, CodexControlConfigLayerMetadata> }
        : {}),
      ...(Array.isArray(result.layers)
        ? { layers: result.layers as ReadonlyArray<CodexControlConfigLayer> }
        : result.layers === null
          ? { layers: null }
          : {}),
    };
  }

  async readAccountTokenUsage(): Promise<unknown> {
    return await this.sendRequest("account/usage/read", undefined);
  }

  async consumeResetCredit(idempotencyKey: string): Promise<unknown> {
    return this.sendRequest("account/rateLimitResetCredit/consume", { idempotencyKey });
  }

  async readAccountRateLimits(): Promise<unknown> {
    return await this.sendRequest("account/rateLimits/read", undefined);
  }

  async batchWriteConfig(
    input: CodexControlConfigBatchWriteInput,
  ): Promise<CodexControlConfigWriteResult> {
    const result = await this.sendRequest<Record<string, unknown>>("config/batchWrite", {
      edits: input.edits,
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
      ...(typeof input.reloadUserConfig === "boolean"
        ? { reloadUserConfig: input.reloadUserConfig }
        : {}),
    });
    const version = asTrimmedString(result.version);
    if (!version) {
      throw new Error("config/batchWrite did not return a version.");
    }
    return {
      version,
      ...(asTrimmedString(result.status) ? { status: asTrimmedString(result.status)! } : {}),
      ...(asTrimmedString(result.filePath) ? { filePath: asTrimmedString(result.filePath)! } : {}),
      ...(result.overriddenMetadata !== undefined
        ? { overriddenMetadata: result.overriddenMetadata }
        : {}),
    };
  }

  getMcpStartupStatuses(): ReadonlyArray<CodexControlMcpServerStatus> {
    return [...this.mcpStartupStatuses.values()];
  }

  async listMcpServerStatus(
    cursor?: string,
    limit?: number,
    timeoutMs?: number,
  ): Promise<CodexControlListMcpServerStatusResult> {
    if (!this.capabilities.listMcpServerStatus) {
      throw new Error("Codex control mcpServerStatus/list is unsupported.");
    }

    const result = await this.sendRequest<Record<string, unknown>>(
      "mcpServerStatus/list",
      {
        ...(cursor ? { cursor } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      },
      Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    );
    if (!Array.isArray(result.data)) throw new Error("Malformed mcpServerStatus/list data.");
    return {
      // Preserve malformed rows/cursors for the bounded traversal to report as partial.
      data: result.data as ReadonlyArray<CodexControlMcpServerStatus>,
      nextCursor: result.nextCursor as string | null,
    };
  }

  /**
   * Page through `model/list`, including hidden rows for launch metadata.
   * Picker consumers filter hidden additions after parsing.
   */
  async listModels(maxPages = 10): Promise<ReadonlyArray<Record<string, unknown>>> {
    return (await this.listModelPages(maxPages)).entries;
  }

  async listModelPages(maxPages = 10) {
    return readCodexModelPages((params) => this.sendRequest("model/list", params), { maxPages });
  }

  /** `skills/list` entries (one per requested cwd) with their skills. */
  async listSkills(cwds: ReadonlyArray<string>): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await this.sendRequest<Record<string, unknown>>("skills/list", {
      cwds: [...cwds],
      forceReload: false,
    });
    return Array.isArray(result.data) ? result.data.filter(isObject) : [];
  }

  /** `hooks/list` for the given working directories (empty: the server cwd). */
  async listHooks(cwds: ReadonlyArray<string>): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await this.sendRequest<Record<string, unknown>>("hooks/list", {
      cwds: [...cwds],
    });
    return Array.isArray(result.data) ? result.data.filter(isObject) : [];
  }

  /** Installed plugins only; F5 never queries remote marketplaces. */
  async listPlugins(cwds: ReadonlyArray<string>): Promise<Record<string, unknown>> {
    return this.sendRequest<Record<string, unknown>>("plugin/list", {
      ...(cwds.length > 0 ? { cwds: [...cwds] } : {}),
      forceRefetch: false,
      marketplaceKinds: ["local"],
    });
  }

  /** Apps/connectors visible to this account (experimental upstream). */
  async listApps(maxPages = 5): Promise<ReadonlyArray<Record<string, unknown>>> {
    return this.listPaged("app/list", { forceRefetch: false }, maxPages);
  }

  private async listPaged(
    method: string,
    params: Record<string, unknown>,
    maxPages: number,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const entries: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.sendRequest<Record<string, unknown>>(method, {
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      if (Array.isArray(result.data)) entries.push(...result.data.filter(isObject));
      cursor = asTrimmedString(result.nextCursor);
      // A repeated cursor would re-read (and duplicate) the same page.
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    return entries;
  }

  async reloadMcpServer(): Promise<void> {
    this.mcpObservationContext = {};
    this.mcpStartupStatuses.clear();
    await this.sendRequest<Record<string, never>>("config/mcpServer/reload", undefined);
  }

  async startOAuthLogin(
    input: CodexControlStartOauthLoginInput,
  ): Promise<CodexControlStartOauthLoginResult> {
    const result = await this.sendRequest<Record<string, unknown>>(
      "mcpServer/oauth/login",
      {
        name: input.name,
        ...(input.scopes && input.scopes.length > 0 ? { scopes: [...input.scopes] } : {}),
        ...(typeof input.timeoutSecs === "number" ? { timeoutSecs: input.timeoutSecs } : {}),
      },
      CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS,
    );
    const authorizationUrl = asTrimmedString(result.authorizationUrl);
    if (!authorizationUrl) {
      throw new Error("mcpServer/oauth/login did not return an authorization URL.");
    }
    return {
      authorizationUrl,
    };
  }

  async closeAndWait(deadline = Date.now() + 1_800): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) {
      this.close();
      return;
    }
    let onExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      onExit = resolve;
      this.child.once("exit", onExit);
    });
    this.close();
    const force = setTimeout(
      () => this.child.kill("SIGKILL"),
      Math.max(0, deadline - Date.now() - 100),
    );
    let limit: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          limit = setTimeout(
            () => reject(new Error("Codex control process did not exit before shutdown deadline.")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(force);
      if (limit) clearTimeout(limit);
      this.child.off("exit", onExit);
    }
  }

  close(): void {
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanupProcessListeners();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new JsonRpcDeliveryError(
          "Codex control client closed.",
          pending.wasWritten === false ? "not_sent" : "unknown",
        ),
      );
      pending.cancelWrite?.();
    }
    this.pending.clear();
    this.output.close();
    this.writer.close();
    if (!this.child.killed) {
      killChildTree(this.child);
    }
    this.emit("closed", new Error("Codex control client closed."));
  }
}
