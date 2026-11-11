import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  callsRouted,
  hostSurvivedFlip,
  liveBridgeHosts,
  parseTabContext,
  processAlive,
} from "./claudeChromeShared";

const listing = (tabGroupId: number, tabIds: number[]) =>
  JSON.stringify({
    availableTabs: tabIds.map((tabId) => ({ tabId, title: "New Tab", url: "chrome://newtab/" })),
    tabGroupId,
  });

describe("parseTabContext", () => {
  it("reads the tab group and tab ids from text blocks or a string", () => {
    expect(
      parseTabContext([
        { type: "text", text: "not json" },
        { type: "text", text: listing(7, [11, 12]) },
      ]),
    ).toEqual({ tabGroupId: 7, tabIds: [11, 12] });
    expect(parseTabContext(listing(3, []))).toEqual({ tabGroupId: 3, tabIds: [] });
  });

  it("rejects results without a numeric group or a tab list", () => {
    expect(parseTabContext([{ type: "text", text: '{"availableTabs":[]}' }])).toBeUndefined();
    expect(parseTabContext([{ type: "text", text: '{"tabGroupId":1}' }])).toBeUndefined();
    expect(parseTabContext([{ type: "image", data: "" }])).toBeUndefined();
    expect(parseTabContext(undefined)).toBeUndefined();
  });
});

describe("liveBridgeHosts", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("lists only live pid sockets, sorted", async () => {
    dir = mkdtempSync(join(tmpdir(), "f5-bridge-"));
    for (const name of ["30.sock", "10.sock", "20.sock", "notes.txt", "x.sock"])
      writeFileSync(join(dir, name), "");
    expect(await liveBridgeHosts(dir, (pid) => pid !== 20)).toEqual([10, 30]);
  });

  it("is empty when the folder is missing", async () => {
    expect(await liveBridgeHosts(join(tmpdir(), "f5-no-such-bridge"), () => true)).toEqual([]);
  });

  it("treats this process as alive", () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});

describe("hostSurvivedFlip", () => {
  const passing = {
    hostsBefore: [42],
    hostsAfter: [42],
    manifestsFlipped: true,
    firstStillConnected: true,
  };

  it("passes when the same host serves across the flip", () => {
    expect(hostSurvivedFlip(passing)).toBe(true);
  });

  it("fails on a replaced, added or missing host, no flip, or a dropped session", () => {
    expect(hostSurvivedFlip({ ...passing, hostsAfter: [43] })).toBe(false);
    expect(hostSurvivedFlip({ ...passing, hostsAfter: [42, 43] })).toBe(false);
    expect(hostSurvivedFlip({ ...passing, hostsBefore: [], hostsAfter: [] })).toBe(false);
    expect(hostSurvivedFlip({ ...passing, manifestsFlipped: false })).toBe(false);
    expect(hostSurvivedFlip({ ...passing, firstStillConnected: false })).toBe(false);
  });
});

describe("callsRouted", () => {
  const a = { tabGroupId: 1, tabIds: [10] };
  const b = { tabGroupId: 2, tabIds: [20] };

  it("passes for distinct, stable groups with disjoint tabs", () => {
    expect(callsRouted({ firstBeforeFlip: a, first: a, second: b })).toBe(true);
  });

  it("fails when a call failed, groups match, tabs overlap or the first group moved", () => {
    expect(callsRouted({ firstBeforeFlip: a, first: a, second: undefined })).toBe(false);
    expect(callsRouted({ firstBeforeFlip: undefined, first: a, second: b })).toBe(false);
    expect(callsRouted({ firstBeforeFlip: a, first: a, second: { ...b, tabGroupId: 1 } })).toBe(
      false,
    );
    expect(callsRouted({ firstBeforeFlip: a, first: a, second: { ...b, tabIds: [10] } })).toBe(
      false,
    );
    expect(callsRouted({ firstBeforeFlip: b, first: a, second: b })).toBe(false);
    expect(callsRouted({ firstBeforeFlip: a, first: { ...a, tabIds: [] }, second: b })).toBe(false);
  });
});
