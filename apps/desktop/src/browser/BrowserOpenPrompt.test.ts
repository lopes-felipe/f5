import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import { createBrowserOpenPrompt } from "./BrowserOpenPrompt";

function setup() {
  const owner = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() };
  const effects = {
    window: vi.fn((_profile: string) => owner as unknown as BrowserWindow | undefined),
    openProfile: vi.fn(async (_profile: string) => {}),
    profileName: (_profile: string) => "Work",
    show: vi.fn(async (_owner: BrowserWindow, _options: Electron.MessageBoxOptions) => ({
      response: 2,
    })),
  };
  const controller = new AbortController();
  const request = {
    profileId: "work",
    host: "example.com",
    url: "https://example.com/login",
    signal: controller.signal,
  };
  return { owner, effects, controller, request, prompt: createBrowserOpenPrompt(effects) };
}

it("focuses only the owning profile and passes the native dialog controls", async () => {
  const h = setup();
  h.request.url += "a".repeat(400);
  expect(await h.prompt(h.request)).toBe(2);
  expect(h.effects.window).toHaveBeenCalledWith("work");
  expect(h.owner.show).toHaveBeenCalledOnce();
  expect(h.owner.focus).toHaveBeenCalledOnce();
  expect(h.effects.openProfile).not.toHaveBeenCalled();
  const [owner, options] = h.effects.show.mock.calls[0]!;
  expect(owner).toBe(h.owner);
  expect(options).toMatchObject({
    message: "example.com",
    signal: h.controller.signal,
    cancelId: 3,
    buttons: ["Open", "Allow example.com until F5 quits", "Copy link", "Cancel"],
  });
  expect(options.detail).toContain('profile "Work"');
  expect(options.detail).toContain(h.request.url.slice(0, 299) + "…");
  expect(options.detail).not.toContain(h.request.url);
});

it("reopens the requesting profile instead of borrowing another profile's window", async () => {
  const h = setup();
  h.effects.window.mockReturnValueOnce(undefined);
  expect(await h.prompt(h.request)).toBe(2);
  expect(h.effects.openProfile).toHaveBeenCalledWith("work");
  expect(h.effects.show.mock.calls[0]![0]).toBe(h.owner);
});

it("denies when reopening fails to provide an owner", async () => {
  const h = setup();
  h.effects.window.mockReturnValue(undefined);
  expect(await h.prompt(h.request)).toBe(3);
  expect(h.effects.show).not.toHaveBeenCalled();
});

it("does not show a late dialog when a request expires while its window reopens", async () => {
  const h = setup();
  h.effects.window.mockReturnValueOnce(undefined);
  h.effects.openProfile.mockImplementation(async () => {
    h.controller.abort();
  });
  expect(await h.prompt(h.request)).toBe(3);
  expect(h.effects.show).not.toHaveBeenCalled();
});
