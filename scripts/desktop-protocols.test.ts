import { expect, it } from "vitest";

import { DESKTOP_PROTOCOLS } from "./lib/desktop-protocols.ts";

it("registers the scheme production prompt links use", () => {
  expect(DESKTOP_PROTOCOLS).toEqual([{ name: "F5 prompt link", schemes: ["f5"] }]);
});
