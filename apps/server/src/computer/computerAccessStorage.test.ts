import { describe, expect, it, vi } from "vitest";
import { computerAccessStorage } from "./computerAccessStorage";
import { ComputerAccessService } from "./ComputerAccessService";

describe("remembered grant recovery", () => {
  it.each([
    '[{"appId":"SENTINEL"',
    '[{"projectId":"p","appId":"x","tier":"future","allowTyping":true}]',
  ])(
    "quarantines invalid data and starts the access service with no grants: %s",
    async (contents) => {
      let file: string | undefined = contents;
      const quarantined = new Map<string, string>();
      const warn = vi.fn();
      const storage = computerAccessStorage({
        exists: async () => file !== undefined,
        read: async () => file!,
        quarantine: async (suffix) => {
          quarantined.set(suffix, file!);
          file = undefined;
        },
        write: async (value) => {
          file = value;
        },
        warn,
      });
      const service = new ComputerAccessService({
        platform: "darwin",
        backendIncarnation: "b",
        storage,
        request: vi.fn(),
        changed: vi.fn(),
        settled: vi.fn(),
      });
      await service.initialize();
      service.bind("t", "p", "s");
      expect(service.grants("t")).toEqual([]);
      expect([...quarantined.values()]).toEqual([contents]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SENTINEL");
      await storage.save([]);
      expect(file).toBe("[]");
      service.close();
    },
  );
  it("preserves an unreadable original and disables future writes if quarantine fails", async () => {
    const write = vi.fn();
    const storage = computerAccessStorage({
      exists: async () => true,
      read: async () => {
        throw new Error("private");
      },
      quarantine: async () => {
        throw new Error("denied");
      },
      write,
      warn: vi.fn(),
    });
    expect(await storage.load()).toEqual([]);
    await expect(storage.save([])).rejects.toThrow("repaired");
    expect(write).not.toHaveBeenCalled();
  });
});
