/** An admitted notification's hold on the queue. */
export interface AdmissionLease {
  /** Returns the entry and every byte it holds. Idempotent. */
  readonly release: () => void;
  /**
   * Charges more bytes to a data lease without taking another entry, for text
   * merged into a notification that is still waiting. Fails on non-data
   * leases, after release, or past the byte limit.
   */
  readonly extend: (bytes: number) => boolean;
}

export interface NotificationAdmissionLimits {
  /** Data entries one context (thread, instance, generation) may hold. */
  readonly entries: number;
  /** Data bytes held across all contexts. */
  readonly bytes: number;
  /** Control entries held across all contexts. */
  readonly controls: number;
  /** Data entries held across all contexts. Defaults to 8,192. */
  readonly globalEntries?: number;
  /** Diagnostic batches held per context. Defaults to two. */
  readonly diagnosticsPerContext?: number;
  /** Diagnostic batches held globally. Defaults to 64. */
  readonly diagnostics?: number;
  /** Diagnostic bytes held globally, independently of data/control. Defaults to 1 MiB. */
  readonly diagnosticBytes?: number;
}

const DEFAULT_LIMITS = {
  entries: 1024,
  bytes: 32 * 1024 * 1024,
  controls: 64,
  globalEntries: 8192,
  diagnosticsPerContext: 2,
  diagnostics: 64,
  diagnosticBytes: 1024 * 1024,
};
const CONTROL_BYTE_LIMIT = 1024 * 1024;

const isByteCount = (bytes: number) => Number.isSafeInteger(bytes) && bytes >= 0;

/**
 * Synchronous notification admission. Native stdout and RPC responses never
 * wait here. Each context gets its own data-entry quota, so one flooding
 * thread cannot exhaust another's; global entry and byte ceilings bound memory.
 */
export class NotificationAdmission {
  private entries = 0;
  private bytes = 0;
  private controls = 0;
  private controlBytes = 0;
  private diagnostics = 0;
  private diagnosticBytes = 0;
  private readonly contextDiagnostics = new Map<string, number>();
  private readonly contextEntries = new Map<string, number>();
  private readonly admitted = new Map<symbol, number>();
  private readonly limits: Required<NotificationAdmissionLimits>;

  constructor(limits?: NotificationAdmissionLimits) {
    this.limits = {
      ...DEFAULT_LIMITS,
      ...limits,
      globalEntries: limits?.globalEntries ?? DEFAULT_LIMITS.globalEntries,
      diagnosticsPerContext: limits?.diagnosticsPerContext ?? DEFAULT_LIMITS.diagnosticsPerContext,
      diagnostics: limits?.diagnostics ?? DEFAULT_LIMITS.diagnostics,
      diagnosticBytes: limits?.diagnosticBytes ?? DEFAULT_LIMITS.diagnosticBytes,
    };
  }

  reserve(contextKey: string, bytes: number, control = false): AdmissionLease | undefined {
    return this.reserveLane(contextKey, bytes, control ? "control" : "data");
  }

  /**
   * Lossy diagnostics never borrow transcript or lifecycle capacity: at most
   * two batches per context, 64 globally, and 1 MiB across those batches by default.
   * Batches reserve their full text allowance, so bytes can bind before entries.
   */
  reserveDiagnostic(contextKey: string, bytes: number): AdmissionLease | undefined {
    return this.reserveLane(contextKey, bytes, "diagnostic");
  }

  private reserveLane(
    contextKey: string,
    bytes: number,
    lane: "data" | "control" | "diagnostic",
  ): AdmissionLease | undefined {
    if (!isByteCount(bytes)) return undefined;
    if (lane === "diagnostic") {
      const held = this.contextDiagnostics.get(contextKey) ?? 0;
      if (held >= this.limits.diagnosticsPerContext || this.diagnostics >= this.limits.diagnostics)
        return undefined;
      if (this.diagnosticBytes + bytes > this.limits.diagnosticBytes) return undefined;
      this.contextDiagnostics.set(contextKey, held + 1);
      this.diagnostics++;
      this.diagnosticBytes += bytes;
    } else if (lane === "control") {
      if (this.controls >= this.limits.controls) return undefined;
      const byteLimit = Math.min(this.limits.bytes, CONTROL_BYTE_LIMIT);
      // A valid large native notification may occupy the queue alone. This is
      // an admission bound, never a Codex stdout frame-size limit.
      if (this.controls > 0 && this.controlBytes + bytes > byteLimit) return undefined;
      this.controls++;
      this.controlBytes += bytes;
    } else {
      const held = this.contextEntries.get(contextKey) ?? 0;
      if (held >= this.limits.entries || this.entries >= this.limits.globalEntries)
        return undefined;
      if (this.entries > 0 && this.bytes + bytes > this.limits.bytes) return undefined;
      this.contextEntries.set(contextKey, held + 1);
      this.entries++;
      this.bytes += bytes;
    }
    const id = Symbol();
    this.admitted.set(id, Date.now());
    let leaseBytes = bytes;
    let released = false;
    return {
      extend: (more) => {
        if (lane !== "data" || released || !isByteCount(more)) return false;
        if (this.bytes + more > this.limits.bytes) return false;
        this.bytes += more;
        leaseBytes += more;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.admitted.delete(id);
        if (lane === "diagnostic") {
          this.diagnostics--;
          this.diagnosticBytes -= leaseBytes;
          const held = (this.contextDiagnostics.get(contextKey) ?? 1) - 1;
          if (held > 0) this.contextDiagnostics.set(contextKey, held);
          else this.contextDiagnostics.delete(contextKey);
          return;
        }
        if (lane === "control") {
          this.controls--;
          this.controlBytes -= leaseBytes;
          return;
        }
        this.entries--;
        this.bytes -= leaseBytes;
        const held = (this.contextEntries.get(contextKey) ?? 1) - 1;
        if (held > 0) this.contextEntries.set(contextKey, held);
        else this.contextEntries.delete(contextKey);
      },
    };
  }

  snapshot() {
    return {
      entries: this.entries,
      controls: this.controls,
      diagnostics: this.diagnostics,
      bytes: this.bytes + this.controlBytes + this.diagnosticBytes,
      oldestAgeMs: this.admitted.size
        ? Math.max(0, Date.now() - Math.min(...this.admitted.values()))
        : 0,
    };
  }
}
