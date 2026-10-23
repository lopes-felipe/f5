import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_DOWNLOAD_MAX_BYTES,
  AGENT_DOWNLOADS_IN_FLIGHT,
  installAgentDownloadHandler,
  pruneAgentDownloads,
} from "./agentDownloads";

function download(filename: string, totalBytes = 1024) {
  const events = new EventEmitter();
  const item = {
    savePath: null as string | null,
    receivedBytes: 0,
    cancelled: false,
    getFilename: () => filename,
    getStartTime: () => 1_700_000_000.25,
    getTotalBytes: () => totalBytes,
    getReceivedBytes: () => item.receivedBytes,
    setSavePath: (savePath: string) => {
      item.savePath = savePath;
    },
    cancel: () => {
      item.cancelled = true;
    },
    on: (event: "updated" | "done", listener: () => void) => events.on(event, listener),
    receive: (bytes: number) => {
      item.receivedBytes = bytes;
      events.emit("updated");
    },
    finish: () => {
      events.emit("done");
    },
  };
  return item;
}

describe("installAgentDownloadHandler", () => {
  it("saves agent-driven downloads without a dialog and leaves the user's alone", () => {
    const session = new EventEmitter();
    const directory = path.join("/state", "preview-downloads");
    installAgentDownloadHandler(session, {
      directoryFor: () => directory,
      isAgentDriven: (id) => id === 7,
      ensureDirectory: () => undefined,
      prune: () => undefined,
    });
    // A second install on the same session must not add a second listener.
    installAgentDownloadHandler(session, {
      directoryFor: () => directory,
      isAgentDriven: () => true,
    });
    expect(session.listenerCount("will-download")).toBe(1);

    const agentExport = download("../report.csv");
    const sameName = download("../report.csv");
    session.emit("will-download", {}, agentExport, { id: 7 });
    session.emit("will-download", {}, sameName, { id: 7 });
    expect(path.dirname(agentExport.savePath!)).toBe(directory);
    expect(path.basename(agentExport.savePath!)).toMatch(/^browser-download-.+-report\.csv$/);
    expect(sameName.savePath).not.toBe(agentExport.savePath);

    // No save path means Electron shows its Save dialog, as for any user download.
    const userDownload = download("photo.png");
    session.emit("will-download", {}, userDownload, { id: 8 });
    expect(userDownload.savePath).toBeNull();
  });

  it("saves each profile's downloads in that profile's folder", () => {
    const session = new EventEmitter();
    const folders: Record<number, string> = {
      1: path.join("/state", "preview-downloads"),
      2: path.join("/state", "profiles", "work", "preview-downloads"),
    };
    installAgentDownloadHandler(session, {
      directoryFor: (id) => folders[id],
      isAgentDriven: () => true,
      ensureDirectory: () => undefined,
      prune: () => undefined,
    });
    const personal = download("a.csv");
    const work = download("b.csv");
    const orphan = download("c.csv");
    session.emit("will-download", {}, personal, { id: 1 });
    session.emit("will-download", {}, work, { id: 2 });
    session.emit("will-download", {}, orphan, { id: 3 });
    expect(path.dirname(personal.savePath!)).toBe(folders[1]);
    expect(path.dirname(work.savePath!)).toBe(folders[2]);
    // An unknown owner keeps the Save dialog instead of borrowing another profile's folder.
    expect(orphan.savePath).toBeNull();
  });

  it("cancels an agent download that is or grows too large, and prunes before each save", () => {
    const session = new EventEmitter();
    const pruned: string[] = [];
    installAgentDownloadHandler(session, {
      directoryFor: () => "/state/preview-downloads",
      isAgentDriven: () => true,
      ensureDirectory: () => undefined,
      prune: (directory) => pruned.push(directory),
    });
    const huge = download("huge.bin", AGENT_DOWNLOAD_MAX_BYTES + 1);
    session.emit("will-download", {}, huge, { id: 1 });
    expect(huge).toMatchObject({ cancelled: true, savePath: null });

    // A server that sends no size is stopped once it passes the cap.
    const unsized = download("stream.bin", 0);
    session.emit("will-download", {}, unsized, { id: 1 });
    unsized.receive(AGENT_DOWNLOAD_MAX_BYTES);
    expect(unsized.cancelled).toBe(false);
    unsized.receive(AGENT_DOWNLOAD_MAX_BYTES + 1);
    expect(unsized.cancelled).toBe(true);
    expect(pruned).toEqual(["/state/preview-downloads"]);
  });
});

describe("agent download admission", () => {
  const install = (overrides: Partial<Parameters<typeof installAgentDownloadHandler>[1]> = {}) => {
    const session = new EventEmitter();
    installAgentDownloadHandler(session, {
      directoryFor: () => "/state/preview-downloads",
      isAgentDriven: () => true,
      ensureDirectory: () => undefined,
      prune: () => undefined,
      ...overrides,
    });
    return session;
  };

  it("admits only a few downloads at once, and admits more as they finish", () => {
    const pruned: Array<ReadonlyArray<string>> = [];
    const session = install({ prune: (_directory, inFlight) => pruned.push([...inFlight]) });
    const items = Array.from({ length: AGENT_DOWNLOADS_IN_FLIGHT + 1 }, (_, index) =>
      download(`file-${index}.bin`),
    );
    for (const item of items) session.emit("will-download", {}, item, { id: 1 });
    expect(items.filter((item) => item.cancelled)).toEqual([items.at(-1)]);

    items[0]!.finish();
    // Finishing prunes again, leaving the downloads still being written alone.
    expect(pruned.at(-1)).toEqual(items.slice(1, -1).map((item) => item.savePath));
    const next = download("next.bin");
    session.emit("will-download", {}, next, { id: 1 });
    expect(next).toMatchObject({ cancelled: false, savePath: expect.any(String) });
  });

  it("cancels the download when its folder cannot be prepared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = install({
        ensureDirectory: () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      });
      const item = download("report.csv");
      expect(() => session.emit("will-download", {}, item, { id: 1 })).not.toThrow();
      expect(item).toMatchObject({ cancelled: true, savePath: null });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("pruneAgentDownloads", () => {
  it("keeps the newest downloads within the folder's byte budget and skips ones in flight", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-downloads-"));
    try {
      const write = (name: string, bytes: number, age: number) => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, Buffer.alloc(bytes));
        fs.utimesSync(file, 1_700_000_000 + age, 1_700_000_000 + age);
        return file;
      };
      write("browser-download-old.bin", 40, 0);
      write("browser-download-middle.bin", 40, 1);
      write("browser-download-new.bin", 40, 2);
      const writing = write("browser-download-writing.bin", 500, 3);
      pruneAgentDownloads(directory, { maxTotalBytes: 100, inFlight: new Set([writing]) });
      expect(fs.readdirSync(directory).sort()).toEqual([
        "browser-download-middle.bin",
        "browser-download-new.bin",
        "browser-download-writing.bin",
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps only the newest saved downloads and leaves other files alone", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-downloads-"));
    try {
      for (let index = 0; index < 5; index++) {
        const file = path.join(directory, `browser-download-${index}.txt`);
        fs.writeFileSync(file, String(index));
        fs.utimesSync(file, 1_700_000_000 + index, 1_700_000_000 + index);
      }
      fs.writeFileSync(path.join(directory, "notes.txt"), "mine");
      pruneAgentDownloads(directory, { keep: 2 });
      expect(fs.readdirSync(directory).sort()).toEqual([
        "browser-download-3.txt",
        "browser-download-4.txt",
        "notes.txt",
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
