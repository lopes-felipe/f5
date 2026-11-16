import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";

/** Subscribe first. A snapshot is installed only with a contiguous, bounded suffix. */
export class TerminalRecovery {
  private version: Pick<TerminalSessionSnapshot, "epoch" | "generation" | "revision"> | null = null;
  private pending = false;
  private disposed = false;
  private connected = true;
  private generation = 0;
  private events: TerminalEvent[] = [];
  private bytes = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private overflow = false;
  constructor(
    private readonly read: () => Promise<TerminalSessionSnapshot | null>,
    private readonly install: (snapshot: TerminalSessionSnapshot) => void,
    private readonly apply: (event: TerminalEvent) => void,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}
  event(event: TerminalEvent): void {
    if (this.disposed || !this.connected) return;
    if (this.pending || !this.version) {
      if (this.overflow) return;
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (this.events.length >= 2_000 || this.bytes + bytes > 4 * 1024 * 1024) {
        this.events = [];
        this.bytes = 0;
        this.overflow = true;
        this.generation++;
      } else {
        this.events.push(event);
        this.bytes += bytes;
      }
      if (!this.pending) void this.sync();
      return;
    }
    const version = this.version;
    if (event.epoch !== version.epoch || event.generation !== version.generation) {
      void this.sync();
      return;
    }
    if (event.revision <= version.revision) return;
    if (event.revision !== version.revision + 1) {
      void this.sync();
      return;
    }
    this.apply(event);
    this.version = event;
  }
  async sync(initial?: () => Promise<TerminalSessionSnapshot | null>): Promise<void> {
    if (this.disposed || !this.connected || this.pending) return;
    this.pending = true;
    this.overflow = false;
    const generation = this.generation;
    try {
      const snapshot = await (initial ?? this.read)();
      if (this.disposed || !this.connected) return;
      if (generation !== this.generation) throw new Error("Terminal buffer overflow.");
      if (!snapshot) {
        this.version = null;
        this.events = [];
        this.bytes = 0;
        return;
      }
      const suffix = this.events.filter(
        (event) => event.epoch !== snapshot.epoch || event.revision > snapshot.revision,
      );
      let revision = snapshot.revision;
      for (const event of suffix) {
        if (event.epoch !== snapshot.epoch || event.generation !== snapshot.generation)
          throw new Error("Terminal generation changed.");
        if (event.revision <= revision) continue;
        if (event.revision !== revision + 1) throw new Error("Terminal event gap.");
        revision = event.revision;
      }
      this.install(snapshot);
      this.version = snapshot;
      for (const event of suffix)
        if (event.revision > this.version.revision) {
          this.apply(event);
          this.version = event;
        }
      this.events = [];
      this.bytes = 0;
    } catch (error) {
      this.events = [];
      this.bytes = 0;
      if (this.connected && !this.disposed) this.onError(error);
      if (!this.disposed && this.connected && !this.retry)
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.sync();
        }, 250);
    } finally {
      this.pending = false;
      if (this.connected && generation !== this.generation && !this.disposed && !this.retry)
        void this.sync();
    }
  }
  connect(): Promise<void> {
    this.connected = true;
    return this.sync();
  }
  disconnect(): void {
    this.connected = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.generation++;
    this.version = null;
    this.events = [];
    this.bytes = 0;
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    this.events = [];
  }
}

/** Open only an unestablished viewport. Reconnects to known sessions are read-only. */
export function terminalSnapshotReader(
  read: () => Promise<TerminalSessionSnapshot | null>,
  open: () => Promise<TerminalSessionSnapshot | null>,
): () => Promise<TerminalSessionSnapshot | null> {
  let established = false;
  return async () => {
    const snapshot = await read();
    if (snapshot) established = true;
    if (established) return snapshot;
    const opened = await open();
    if (opened) established = true;
    return opened;
  };
}
