import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  callsRouted,
  classifyListing,
  hostSurvivedFlip,
  liveBridgeHosts,
  parseBrowserChoice,
  parseTabContext,
  processAlive,
  resultShape,
  sameGroup,
  scrubError,
  sharedTabCount,
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

  it("accepts a listing without a group id, as the CLI's format allows", () => {
    expect(
      parseTabContext([{ type: "text", text: '{"availableTabs":[{"tabId":5,"url":"x"}]}' }]),
    ).toEqual({ tabIds: [5] });
  });

  it("reads the CLI's two blocks when a transcript joins them into one string", () => {
    const joined = `${listing(7, [11, 12])}\n\nTab Context:\n- Available tabs:\n  • tabId 11: "New Tab" ("chrome://newtab/")`;
    expect(parseTabContext(joined)).toEqual({ tabGroupId: 7, tabIds: [11, 12] });
    expect(parseTabContext([{ type: "text", text: `prefix ${listing(2, [3])} suffix {` }])).toEqual(
      { tabGroupId: 2, tabIds: [3] },
    );
    // Braces inside strings don't end the object.
    const tricky = JSON.stringify({
      availableTabs: [{ tabId: 4, title: "a } b {", url: "x" }],
      tabGroupId: 9,
    });
    expect(parseTabContext(`note: ${tricky}`)).toEqual({ tabGroupId: 9, tabIds: [4] });
  });

  it("falls back to the readable listing, without a group id", () => {
    expect(
      parseTabContext(
        'Tab Context:\n- Available tabs:\n  • tabId 11: "A" ("x")\n  • tabId 12: "B" ("y")',
      ),
    ).toEqual({ tabIds: [11, 12] });
  });

  it("describes an unreadable result without its content", () => {
    expect(resultShape([{ type: "text", text: "secret page" }, { type: "image" }])).toEqual({
      kind: "array",
      blocks: ["text", "image"],
      textLength: 11,
      hasAvailableTabs: false,
      hasTabGroupId: false,
      hasReadableListing: false,
    });
  });

  it("rejects results without a tab list", () => {
    expect(parseTabContext([{ type: "text", text: '{"tabGroupId":1}' }])).toBeUndefined();
    expect(parseTabContext([{ type: "image", data: "" }])).toBeUndefined();
    expect(parseTabContext(undefined)).toBeUndefined();
  });
});

describe("classifyListing", () => {
  const denial = "Only a tab listing";
  const ok = (text: string) => ({ isError: false, content: [{ type: "text", text }] });
  const err = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

  it("says why a listing turn failed", () => {
    expect(classifyListing([ok(listing(1, [2]))], denial)).toEqual({
      outcome: "ok",
      context: { tabGroupId: 1, tabIds: [2] },
    });
    expect(classifyListing([ok('{"availableTabs":[]}')], denial).outcome).toBe("ok-no-group-id");
    expect(classifyListing([], denial).outcome).toBe("not-called");
    expect(classifyListing([ok("Tabs: none")], denial)).toMatchObject({
      outcome: "unreadable",
      shape: { kind: "array", textLength: 10 },
    });
    expect(classifyListing([err(`${denial} is allowed.`)], denial).outcome).toBe("denied");
    expect(
      classifyListing([err("Extension not connected; see https://claude.ai/x?y=1")], denial),
    ).toEqual({ outcome: "tool-error", error: "Extension not connected; see <url>" });
  });

  it("recognises the CLI's browser choice, flagged or not, and picks this Mac's browser", () => {
    const choice =
      '2 Chrome browsers are connected to this account, 1 of them on this computer, and none has been selected for this session. Ask the user. List the browsers on this computer first, in the order below. Browsers on this computer: 1. "Chrome" (macOS) — deviceId: local-1 Other connected browsers: 2. "Work" (Windows) — deviceId: remote-2';
    for (const result of [ok(choice), err(choice)])
      expect(classifyListing([result], denial)).toEqual({
        outcome: "browser-not-selected",
        choice: { connected: 2, local: 1, localDeviceId: "local-1" },
      });
    expect(
      parseBrowserChoice(
        'Multiple Chrome browsers are connected to this account and none has been selected for this session. Connected browsers: 1. "A" (Linux) — deviceId: r-1',
      ),
    ).toEqual({ connected: 1, local: 0 });
    expect(parseBrowserChoice(listing(1, [2]))).toBeUndefined();
  });

  it("keeps device ids and UUIDs out of scrubbed text", () => {
    expect(scrubError("deviceId: abc-123 id 0f22c62c-1111-2222-3333-444455556666")).toBe(
      "deviceId: <id> id <uuid>",
    );
  });

  it("prefers a successful listing over an earlier failed one", () => {
    expect(classifyListing([err("timed out"), ok(listing(4, [9]))], denial).outcome).toBe("ok");
  });

  it("truncates scrubbed errors", () => {
    expect(scrubError("x".repeat(500))).toHaveLength(200);
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

  it("compares tabs when listings carry no group id", () => {
    const x = { tabIds: [10] };
    const y = { tabIds: [20] };
    expect(callsRouted({ firstBeforeFlip: x, first: x, second: y })).toBe(true);
    expect(callsRouted({ firstBeforeFlip: x, first: x, second: { tabIds: [10] } })).toBe(false);
    expect(callsRouted({ firstBeforeFlip: x, first: { tabIds: [11] }, second: y })).toBe(false);
  });
});

describe("sameGroup and sharedTabCount", () => {
  it("matches by group id and tabs, or by tabs alone", () => {
    expect(sameGroup({ tabGroupId: 1, tabIds: [2, 3] }, { tabGroupId: 1, tabIds: [3, 2] })).toBe(
      true,
    );
    expect(sameGroup({ tabGroupId: 1, tabIds: [2] }, { tabGroupId: 2, tabIds: [2] })).toBe(false);
    expect(sameGroup({ tabIds: [2] }, { tabGroupId: 5, tabIds: [2] })).toBe(true);
    expect(sameGroup({ tabIds: [] }, { tabIds: [] })).toBe(false);
    expect(sameGroup(undefined, undefined)).toBe(false);
    expect(sharedTabCount({ tabIds: [1, 2, 3] }, { tabIds: [3, 2, 9] })).toBe(2);
    expect(sharedTabCount(undefined, { tabIds: [1] })).toBe(0);
  });
});
