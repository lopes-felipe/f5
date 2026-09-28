import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn() }));
vi.mock("./components/ui/toast", () => ({ toastManager: toast }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("thread undo", () => {
  it("only undoes visible, unexpired actions", async () => {
    const { recordThreadUndo, undoThreadAction, canUndoThreadAction } =
      await import("./threadUndo");
    const undo = vi.fn().mockResolvedValue(undefined);
    recordThreadUndo("Archived", undo);
    expect(canUndoThreadAction()).toBe(true);
    toast.add.mock.calls[0]![0].onClose();
    expect(await undoThreadAction()).toBe(false);
    recordThreadUndo("Snoozed", undo);
    vi.advanceTimersByTime(8000);
    expect(canUndoThreadAction()).toBe(false);
    expect(await undoThreadAction()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it("keeps the ten newest actions and applies inverses in reverse order", async () => {
    const { recordThreadUndo, undoThreadAction } = await import("./threadUndo");
    const applied: number[] = [];
    for (let i = 0; i < 11; i++)
      recordThreadUndo("Archived", async () => {
        applied.push(i);
      });
    expect(toast.close).toHaveBeenCalledWith(toast.add.mock.calls[0]![0].id);
    for (let i = 0; i < 10; i++) expect(await undoThreadAction()).toBe(true);
    expect(await undoThreadAction()).toBe(false);
    expect(applied).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("prevents concurrent inverses and keeps a failed action retryable", async () => {
    const { recordThreadUndo, undoThreadAction } = await import("./threadUndo");
    let reject!: (error: Error) => void;
    const undo = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    recordThreadUndo("Unpinned", undo);
    const first = undoThreadAction();
    expect(await undoThreadAction()).toBe(false);
    reject(new Error("Offline"));
    expect(await first).toBe(false);
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: "Offline" }),
    );
    expect(await undoThreadAction()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(2);
  });
});
