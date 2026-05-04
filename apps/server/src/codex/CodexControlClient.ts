import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { type CodexMcpServerEntry } from "@t3tools/contracts";
import {
  assertSupportedCodexCliVersion,
  buildCodexInitializeParams,
  killChildTree,
} from "../codexAppServerManager.ts";
import { createJsonRpcStdinWriter, type JsonRpcStdinWriter } from "./JsonRpcStdinWriter.ts";
import { prependCodexCliTelemetryDisabledConfig } from "../provider/codexCliConfig.ts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";
import { resolveCodexHome } from "../os-jank.ts";

interface PendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
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
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly mcpServers?: Record<string, CodexMcpServerEntry>;
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

export function isMethodNotFoundError(error: unknown): boolean {
  return (
    (error instanceof CodexControlRequestError && error.code === -32601) ||
    (error instanceof Error && /method not found/i.test(error.message))
  );
}

export class CodexControlClient extends EventEmitter<{
  notification: [CodexControlNotification];
}> {
  capabilities: CodexControlCapabilities;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: readline.Interface;
  private readonly writer: JsonRpcStdinWriter;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  private constructor(
    private readonly environment: CodexControlEnvironmentConfig,
    child: ChildProcessWithoutNullStreams,
    output: readline.Interface,
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

  static async create(environment: CodexControlEnvironmentConfig): Promise<CodexControlClient> {
    const binaryPath = environment.binaryPath ?? "codex";
    const codexHomePath = resolveCodexHome({ homePath: environment.homePath });
    assertSupportedCodexCliVersion({
      binaryPath,
      cwd: environment.cwd,
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
    });

    const child = spawn(
      binaryPath,
      prependCodexCliTelemetryDisabledConfig(["app-server"], {
        mcpServers: environment.mcpServers ?? {},
      }),
      {
        cwd: environment.cwd,
        env: buildProviderChildProcessEnv(
          process.env,
          codexHomePath ? { CODEX_HOME: codexHomePath } : undefined,
        ),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    const output = readline.createInterface({ input: child.stdout });
    const writer = createJsonRpcStdinWriter({
      stdin: child.stdin,
      closedMessage: "Codex control client is closed.",
    });

    const client = new CodexControlClient(environment, child, output, writer, {
      configRead: false,
      listMcpServerStatus: false,
    });

    await client.sendRequest("initialize", buildCodexInitializeParams());
    await client.writeMessage({
      method: "initialized",
    });
    client.capabilities = await client.probeCapabilities();
    return client;
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
    this.output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (isJsonRpcResponse(parsed)) {
        this.handleResponse(parsed);
        return;
      }

      if (isJsonRpcNotification(parsed)) {
        this.emit("notification", {
          method: parsed.method,
          params: parsed.params,
        });
      }
    });

    const handleExit = (cause: Error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(cause);
      }
      this.pending.clear();
      this.output.close();
      this.writer.close(cause);
    };

    this.child.once("error", (error) => {
      handleExit(error instanceof Error ? error : new Error(String(error)));
    });

    this.child.once("exit", (code, signal) => {
      handleExit(
        new Error(
          `codex control client exited (code=${String(code ?? "null")}, signal=${String(
            signal ?? "null",
          )}).`,
        ),
      );
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

  private async writeMessage(message: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("Codex control client is closed.");
    }
    await this.writer.write(message);
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
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.pending.set(String(id), {
        method,
        timeout,
        resolve: (value) => resolve(value as TResponse),
        reject,
      });

      void this.writeMessage({
        id,
        method,
        params,
      }).catch((error) => {
        clearTimeout(timeout);
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

  async listMcpServerStatus(
    cursor?: string,
    limit?: number,
  ): Promise<CodexControlListMcpServerStatusResult> {
    if (!this.capabilities.listMcpServerStatus) {
      throw new Error("Codex control mcpServerStatus/list is unsupported.");
    }

    const result = await this.sendRequest<Record<string, unknown>>("mcpServerStatus/list", {
      ...(cursor ? { cursor } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    return {
      data: Array.isArray(result.data)
        ? (result.data.filter((entry): entry is CodexControlMcpServerStatus =>
            isObject(entry),
          ) as ReadonlyArray<CodexControlMcpServerStatus>)
        : [],
      nextCursor: result.nextCursor === null ? null : (asTrimmedString(result.nextCursor) ?? null),
    };
  }

  async reloadMcpServer(): Promise<void> {
    await this.sendRequest<Record<string, never>>("config/mcpServer/reload", undefined);
  }

  async startOAuthLogin(
    input: CodexControlStartOauthLoginInput,
  ): Promise<CodexControlStartOauthLoginResult> {
    const result = await this.sendRequest<Record<string, unknown>>("mcpServer/oauth/login", {
      name: input.name,
      ...(input.scopes && input.scopes.length > 0 ? { scopes: [...input.scopes] } : {}),
      ...(typeof input.timeoutSecs === "number" ? { timeoutSecs: input.timeoutSecs } : {}),
    });
    const authorizationUrl = asTrimmedString(result.authorizationUrl);
    if (!authorizationUrl) {
      throw new Error("mcpServer/oauth/login did not return an authorization URL.");
    }
    return {
      authorizationUrl,
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex control client closed."));
    }
    this.pending.clear();
    this.output.close();
    this.writer.close();
    if (!this.child.killed) {
      killChildTree(this.child);
    }
  }
}
