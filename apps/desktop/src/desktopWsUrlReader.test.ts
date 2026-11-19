import { expect, it, vi } from "vitest";
import { createDesktopWsUrlReader } from "./desktopWsUrlReader";

it("caches null and populated URLs for a minute and refreshes after clock rollback", () => {
  let now = 0;
  const read = vi.fn<() => string | null>().mockReturnValue(null);
  const get = createDesktopWsUrlReader(read, () => now);
  expect(get()).toBeNull();
  now = 59_999;
  expect(get()).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  read.mockReturnValue("ws://localhost/?token=fresh");
  now = 60_000;
  expect(get()).toContain("fresh");
  expect(get()).toContain("fresh");
  expect(read).toHaveBeenCalledTimes(2);
  now = 1;
  get();
  expect(read).toHaveBeenCalledTimes(3);
});
