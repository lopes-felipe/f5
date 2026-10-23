import type { SDKMessage, PermissionMode, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

/** SDK query fake shared by adapter and process-crash tests. */
export class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly applyFlagSettingsCalls: Array<Record<string, unknown>> = [];
  public readonly stopTaskCalls: string[] = [];
  public readonly getTaskOutputCalls: string[] = [];
  public readonly renameSessionCalls: Array<{ title: string; sessionId?: string }> = [];
  readonly renameSession = async (title: string, sessionId?: string) => {
    this.renameSessionCalls.push({ title, ...(sessionId ? { sessionId } : {}) });
  };
  readonly getTaskOutput = async (taskId: string) => {
    this.getTaskOutputCalls.push(taskId);
    return { output: "isolated shell output", total_bytes: 30, truncated: true };
  };
  public readonly rewindFilesCalls: Array<{ uuid: string; dryRun: boolean }> = [];
  public rewindFilesResult = {
    canRewind: true,
    filesChanged: ["sample.txt"],
    insertions: 1,
    deletions: 2,
  };
  readonly stopTask = async (taskId: string) => {
    this.stopTaskCalls.push(taskId);
  };
  readonly rewindFiles = async (uuid: string, options?: { dryRun?: boolean }) => {
    this.rewindFilesCalls.push({ uuid, dryRun: options?.dryRun === true });
    return this.rewindFilesResult;
  };
  public closeCalls = 0;
  public onClose: (() => void) | undefined;
  public readonly deliveredAfterClose: SDKMessage[] = [];

  /** Simulate buffered transport frames that remain readable after close. */
  forceEmit(message: SDKMessage): void {
    this.queue.push(message);
  }
  public initializationResultValue: unknown = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {},
  };
  public supportedModelsValue: ReadonlyArray<unknown> = [];
  private supportedModelsPromise: Promise<ReadonlyArray<unknown>> | undefined;
  public supportedCommands?: () => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>
  >;

  setSupportedCommandsResult(
    result: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>,
  ): void {
    this.supportedCommands = async () => result;
  }

  setInitializationResult(result: unknown): void {
    this.initializationResultValue = result;
  }

  setSupportedModelsResult(result: ReadonlyArray<unknown>): void {
    this.supportedModelsValue = result;
    this.supportedModelsPromise = undefined;
  }

  setSupportedModelsPromise(result: Promise<ReadonlyArray<unknown>>): void {
    this.supportedModelsPromise = result;
  }

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  /** Set by tests that exercise Claude's graceful interrupt. */
  public onInterrupt: (() => Promise<void>) | undefined;
  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
    await this.onInterrupt?.();
  };

  public setModelWait: Promise<void> | undefined;
  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
    await this.setModelWait;
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly applyFlagSettings = async (settings: Record<string, unknown>): Promise<void> => {
    this.applyFlagSettingsCalls.push(settings);
  };

  readonly initializationResult = async (): Promise<unknown> => this.initializationResultValue;

  public mcpServerStatusValue: Array<McpServerStatus> = [];
  public mcpServerStatusCalls = 0;
  // A prototype method that needs `this`, like the SDK's Query: callers must keep the receiver.
  async mcpServerStatus(): Promise<ReadonlyArray<McpServerStatus>> {
    this.mcpServerStatusCalls += 1;
    return this.mcpServerStatusValue;
  }

  public readonly toggleMcpServerCalls: Array<{ name: string; enabled: boolean }> = [];
  public toggleMcpServerFailure: unknown;
  readonly toggleMcpServer = async (name: string, enabled: boolean): Promise<void> => {
    this.toggleMcpServerCalls.push({ name, enabled });
    if (this.toggleMcpServerFailure !== undefined) throw this.toggleMcpServerFailure;
    const entry = this.mcpServerStatusValue.find((candidate) => candidate.name === name);
    if (entry) entry.status = enabled ? "connected" : "disabled";
  };

  readonly supportedModels = async (): Promise<ReadonlyArray<unknown>> =>
    this.supportedModelsPromise ?? this.supportedModelsValue;

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
    this.onClose?.();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            if (this.closeCalls > 0) this.deliveredAfterClose.push(value);
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}
