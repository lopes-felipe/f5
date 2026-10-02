import { it, expect, vi } from "vitest";
import { installGuestControls } from "./guestControls";
it("keeps editing commands in the browser guest", () => {
  let handler: any;
  const guest = {
    setIgnoreMenuShortcuts: vi.fn(),
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
