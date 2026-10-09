import { describe, expect, it } from "vitest";

import { ComputerUseLease } from "./computerUseLease.ts";

describe("ComputerUseLease", () => {
  it("lets exactly one thread control the computer and notifies on change", () => {
    const lease = new ComputerUseLease();
    const seen: Array<string | null> = [];
    const unsubscribe = lease.subscribe((holder) => seen.push(holder));
    expect(lease.acquire("a")).toBe(true);
    expect(lease.acquire("a")).toBe(true);
    expect(lease.acquire("b")).toBe(false);
    expect(lease.isHeldByOther("b")).toBe(true);
    lease.release("b");
    expect(lease.current()).toBe("a");
    lease.release("a");
    expect(lease.acquire("b")).toBe(true);
    unsubscribe();
    lease.release("b");
    expect(seen).toEqual(["a", null, "b"]);
  });

  it("keeps the lease consistent when an observer throws", () => {
    const lease = new ComputerUseLease();
    lease.subscribe(() => {
      throw new Error("observer failed");
    });
    expect(lease.acquire("a")).toBe(true);
    expect(lease.current()).toBe("a");
  });
});
