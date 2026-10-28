import { it, expect, vi } from "vitest";
import { installGuestControls } from "./guestControls";
it("keeps editing commands in the browser guest", () => {
  let handler: any;
  const guest = {
    setIgnoreMenuShortcuts: vi.fn(),
    isFocused: vi.fn(() => true),
    focusedFrame: {},
    on: vi.fn((_name, fn) => (handler = fn)),
    copy: vi.fn(),
    paste: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  installGuestControls(guest as never);
  const event = { preventDefault: vi.fn() };
  handler(event, { type: "keyDown", meta: true, key: "c" });
  expect(guest.copy).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  handler(event, { type: "keyDown", meta: true, shift: true, key: "z" });
  expect(guest.redo).toHaveBeenCalledOnce();
  expect(guest.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
});

it("edits the focused guest and ignores keys sent to a background guest", () => {
  const makeGuest = () => {
    let handler: (event: any, input: any) => void;
    const guest = {
      setIgnoreMenuShortcuts: vi.fn(),
      isFocused: vi.fn(() => true),
      focusedFrame: {} as object | null,
      on: vi.fn((_name, fn) => (handler = fn)),
      copy: vi.fn(),
      cut: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
    };
    installGuestControls(guest as never);
    return {
      guest,
      press: (key: string) =>
        handler!(
          { preventDefault: vi.fn() },
          {
            type: "keyDown",
            meta: true,
            key,
          },
        ),
    };
  };
  const older = makeGuest();
  const newer = makeGuest();
  newer.guest.focusedFrame = null;
  for (const [key, action] of [
    ["v", "paste"],
    ["c", "copy"],
    ["x", "cut"],
    ["a", "selectAll"],
    ["z", "undo"],
  ] as const) {
    older.press(key);
    newer.press(key);
    expect(older.guest[action]).toHaveBeenCalledOnce();
    expect(newer.guest[action]).not.toHaveBeenCalled();
  }
  older.guest.isFocused.mockReturnValue(false);
  older.press("v");
  expect(older.guest.paste).toHaveBeenCalledOnce();
});
