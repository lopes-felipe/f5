import { expect, it } from "vitest";
import { createFileActionGesture } from "./fileActionGesture";

function fixture() {
  let now = 0;
  const listeners = new Map<string, EventListener>();
  const take = createFileActionGesture(
    {
      addEventListener(name: string, listener: EventListener, capture: boolean) {
        expect(capture).toBe(true);
        listeners.set(name, listener);
      },
    } as Pick<Window, "addEventListener">,
    () => now,
  );
  return {
    take,
    advance: (ms: number) => (now += ms),
    emit(name: string, props: Partial<MouseEvent> = {}) {
      listeners.get(name)!({ isTrusted: true, button: 0, detail: 1, ...props } as MouseEvent);
    },
  };
}

it("authorizes xterm mouseup after holding Cmd/Ctrl beyond the keydown deadline", () => {
  const f = fixture();
  f.emit("keydown", { metaKey: true });
  f.advance(1500);
  f.emit("mouseup", { metaKey: true });
  expect(f.take()).toBe(true);
  // xterm has already activated its link when the browser emits click.
  f.emit("click", { metaKey: true });
  expect(f.take()).toBe(false);
});

it("allows ordinary buttons and keyboard/accessible clicks without reusing a grant", () => {
  const f = fixture();
  f.emit("mouseup");
  f.emit("click");
  expect(f.take()).toBe(true);
  expect(f.take()).toBe(false);
  f.emit("click", { detail: 0 });
  expect(f.take()).toBe(true);
  f.emit("keydown");
  expect(f.take()).toBe(true);
});

it("rejects synthetic events, non-primary mouse buttons, and expired gestures", () => {
  const f = fixture();
  f.emit("mouseup", { isTrusted: false });
  expect(f.take()).toBe(false);
  f.emit("click", { isTrusted: false, detail: 0 });
  expect(f.take()).toBe(false);
  f.emit("keydown", { isTrusted: false });
  expect(f.take()).toBe(false);
  f.emit("mouseup", { button: 2 });
  expect(f.take()).toBe(false);
  f.emit("mouseup");
  f.advance(1000);
  expect(f.take()).toBe(false);
});
