import { it, expect, vi } from "vitest";
import { CaptureShortcut } from "./CaptureShortcut";
it("preserves a live shortcut on failed replacement and fences other renderer cleanup", () => {
  const registered = new Map<string, () => void>(),
    unregister = vi.fn((key: string) => registered.delete(key));
  const register = vi.fn((key: string, fn: () => void) => {
    if (key === "blocked") return false;
    registered.set(key, fn);
    return true;
  });
  const controls = new CaptureShortcut(register, unregister),
    first = vi.fn(),
    second = vi.fn();
  controls.configure(1, "first", true, first);
  expect(() => controls.configure(1, "blocked", true, first)).toThrow();
  registered.get("first")!();
  expect(first).toHaveBeenCalledOnce();
  expect(unregister).not.toHaveBeenCalled();
  controls.configure(2, "first", true, second);
  controls.release(1);
  registered.get("first")!();
  expect(second).toHaveBeenCalledOnce();
  controls.release(2);
  expect(unregister).toHaveBeenCalledWith("first");
});

it("routes to the active enabled window and retains the shortcut when another closes", () => {
  const callbacks = new Map<string, () => void>();
  let active = 1;
  const unregister = vi.fn();
  const shortcut = new CaptureShortcut(
    (key, callback) => {
      callbacks.set(key, callback);
      return true;
    },
    unregister,
    () => active,
  );
  const a = vi.fn(),
    b = vi.fn();
  shortcut.configure(1, "same", true, a);
  shortcut.configure(2, "same", true, b);
  callbacks.get("same")!();
  expect(a).toHaveBeenCalledOnce();
  active = 2;
  callbacks.get("same")!();
  expect(b).toHaveBeenCalledOnce();
  shortcut.release(2);
  callbacks.get("same")!();
  expect(a).toHaveBeenCalledTimes(2);
  expect(unregister).not.toHaveBeenCalled();
});
