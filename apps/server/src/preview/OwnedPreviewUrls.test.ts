import { expect, it, vi } from "vitest";
import { OwnedPreviewUrls, scanLocalServers, filterReadyLocalServers } from "./PortScanner";

it("collects complete local origins across chunks and isolates each output source", () => {
  const collector = new OwnedPreviewUrls();
  collector.append("a", "Listening http://localhost:51");
  collector.append("b", "73/\nhttps://example.com/\n");
  expect([...collector.urls]).toEqual([]);
  collector.append("a", "73/\n");
  expect([...collector.urls]).toEqual(["http://localhost:5173"]);
  collector.append("a", "\u001b[32mhttps://127.0.0.1:4000/\u001b[0m\n");
  expect(collector.urls.has("https://127.0.0.1:4000")).toBe(true);
});

it("never probes machine ports without an owned URL", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    expect(await scanLocalServers()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("does not advertise an owned server returning 5xx as ready", async () => {
  const servers = [
    { host: "localhost", port: 5173, url: "http://localhost:5173", pid: null, processName: null },
  ];
  expect(
    await filterReadyLocalServers(servers, {
      fetchImplementation: async () => new Response("unavailable", { status: 503 }),
    }),
  ).toEqual([]);
});
