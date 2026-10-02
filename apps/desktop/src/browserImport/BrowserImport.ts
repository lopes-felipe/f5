import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import type { DesktopBrowserImportProgress } from "@t3tools/contracts";
import type { BrowserProfiles } from "../preview/BrowserProfiles";
import { discoverSources, publicSources } from "./sources";
import { readCookies } from "./readCookies";
export class BrowserImport {
  readonly #jobs = new Map<
    string,
    { progress: DesktopBrowserImportProgress; abort: AbortController }
  >();
  constructor(
    readonly profiles: BrowserProfiles,
    readonly sessionFor: (partition: string) => Pick<Session, "cookies">,
    readonly options: { discover?: typeof discoverSources; read?: typeof readCookies } = {},
  ) {}
  async sources() {
    return publicSources(await (this.options.discover ?? discoverSources)());
  }
  async start(sourceId: string, profileId: string, name: string): Promise<string> {
    if (!name.trim() || name.length > 100) throw new Error("Invalid browser profile name.");
    if ([...this.#jobs.values()].some((j) => ["reading", "writing"].includes(j.progress.status)))
      throw new Error("An import is already running.");
    const source = (await (this.options.discover ?? discoverSources)())
      .find((s) => s.id === sourceId)
      ?.profiles.find((p) => p.id === profileId);
    if (!source) throw new Error("Unknown import source.");
    if ([...this.#jobs.values()].some((j) => ["reading", "writing"].includes(j.progress.status)))
      throw new Error("An import is already running.");
    if (this.#jobs.size >= 32) {
      const oldest = [...this.#jobs].find(
        ([, j]) => !["reading", "writing"].includes(j.progress.status),
      );
      if (oldest) this.#jobs.delete(oldest[0]);
    }
    const id = randomUUID(),
      abort = new AbortController();
    const job: { progress: DesktopBrowserImportProgress; abort: AbortController } = {
      progress: {
        id,
        status: "reading" as DesktopBrowserImportProgress["status"],
        imported: 0,
        skipped: 0,
        failed: 0,
      },
      abort,
    };
    this.#jobs.set(id, job);
    void this.#run(job, source, name).catch(() => {
      job.progress.status = "failed";
      job.progress.error = "Import staging could not be created. Retry.";
    });
    return id;
  }
  cancel(id: string) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("Unknown import.");
    if (["reading", "writing"].includes(job.progress.status)) job.abort.abort();
  }
  status(id: string): DesktopBrowserImportProgress {
    const job = this.#jobs.get(id);
    if (!job)
      throw new Error("Import ended or was interrupted by a restart. Retry into a new profile.");
    return { ...job.progress };
  }
  async #run(
    job: { progress: DesktopBrowserImportProgress; abort: AbortController },
    source: Parameters<typeof readCookies>[0],
    name: string,
  ) {
    const stage = await this.profiles.stage(name);
    try {
      const read = await (this.options.read ?? readCookies)(source, job.abort.signal);
      job.progress.skipped = read.skipped;
      job.progress.status = "writing";
      const session = this.sessionFor(stage.partition);
      for (const cookie of read.cookies) {
        job.abort.signal.throwIfAborted();
        try {
          await session.cookies.set(cookie);
          job.progress.imported++;
        } catch {
          job.progress.failed++;
        }
      }
      job.abort.signal.throwIfAborted();
      await session.cookies.flushStore();
      job.abort.signal.throwIfAborted();
      const profile = await stage.commit();
      job.progress.profileId = profile.id;
      job.progress.status = "completed";
    } catch {
      await stage.discard().catch(() => undefined);
      job.progress.status = job.abort.signal.aborted ? "canceled" : "failed";
      job.progress.error = job.abort.signal.aborted
        ? "Import canceled. Existing profiles were untouched."
        : "Import could not finish. Close the source browser and check OS permissions, then retry. Safari requires Full Disk Access; Windows app-bound encryption is unsupported.";
    }
  }
}
