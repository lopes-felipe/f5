import { describe, expect, it } from "vitest";

import {
  PromptLinkInbox,
  promptLinkInArgv,
  promptLinkSchemeFor,
  entryScriptInArgv,
  protocolClientRegistration,
} from "./promptLinkInbox";

describe("PromptLinkInbox", () => {
  it("queues this build's links until a renderer takes them", () => {
    const inbox = new PromptLinkInbox("f5");
    expect(inbox.receive("f5://new?prompt=Fix%20it&repo=octo/tools")).toBe(true);
    expect(inbox.receive("F5://thread/thread-1?prompt=Retry")).toBe(true);
    expect(inbox.take()).toEqual([
      "f5://new?prompt=Fix%20it&repo=octo/tools",
      "F5://thread/thread-1?prompt=Retry",
    ]);
    expect(inbox.take()).toEqual([]);
  });

  it("refuses other schemes and routes a link must not reach", () => {
    const inbox = new PromptLinkInbox("f5");
    expect(inbox.receive("f5-dev://new?prompt=x")).toBe(false);
    expect(inbox.receive("https://example.com/new?prompt=x")).toBe(false);
    expect(inbox.receive("f5://settings")).toBe(false);
    expect(inbox.receive("f5://thread/../settings?prompt=x")).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it("gives a link only to the profile it was sent to", () => {
    const inbox = new PromptLinkInbox("f5");
    inbox.receive("f5://new?prompt=work", "work");
    inbox.receive("f5://new?prompt=any", null);
    // A background window of another profile loading meanwhile takes only the unaddressed link.
    expect(inbox.take("personal")).toEqual(["f5://new?prompt=any"]);
    expect(inbox.take("work")).toEqual(["f5://new?prompt=work"]);
    expect(inbox.take("work")).toEqual([]);
  });

  it("keeps only the most recent links", () => {
    const inbox = new PromptLinkInbox("f5");
    for (let index = 0; index < 12; index++) inbox.receive(`f5://new?prompt=${index}`);
    const pending = inbox.take();
    expect(pending).toHaveLength(10);
    expect(pending[0]).toBe("f5://new?prompt=2");
  });
});

describe("protocol registration", () => {
  it("uses a separate scheme for development builds", () => {
    expect(promptLinkSchemeFor(false)).toBe("f5");
    expect(promptLinkSchemeFor(true)).toBe("f5-dev");
  });

  it("passes the entry script back to an unpackaged Electron", () => {
    expect(
      protocolClientRegistration({
        defaultApp: true,
        execPath: "/dev/electron",
        entryScript: "/repo/apps/desktop/dist-electron/main.js",
      }),
    ).toEqual({ path: "/dev/electron", args: ["/repo/apps/desktop/dist-electron/main.js"] });
    expect(
      protocolClientRegistration({ defaultApp: false, execPath: "/F5", entryScript: undefined }),
    ).toBeNull();
  });

  it("finds the entry script past the dev launcher's switches", () => {
    expect(
      entryScriptInArgv([
        "/dev/electron",
        "--t3code-dev-root=/repo/apps/desktop",
        "dist-electron/main.js",
      ]),
    ).toBe("dist-electron/main.js");
    expect(entryScriptInArgv(["/dev/electron", "/repo/main.js"])).toBe("/repo/main.js");
    expect(entryScriptInArgv(["/dev/electron", "--inspect"])).toBeUndefined();
  });

  it("finds a link among a second launch's arguments", () => {
    expect(promptLinkInArgv(["/F5", "--flag", "f5://new?prompt=x"], "f5")).toBe(
      "f5://new?prompt=x",
    );
    expect(promptLinkInArgv(["/F5", "--flag"], "f5")).toBeNull();
  });
});
