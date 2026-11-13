import { expect, it } from "vitest";
import { parseProjectFileScripts } from "./projectFileScripts";
it("imports only reviewed action data, dropping repository autorun and shortcut flags", () => {
  expect(
    parseProjectFileScripts(
      JSON.stringify({
        scripts: [
          {
            name: " Test ",
            command: " npm run test ",
            runOnWorktreeCreate: true,
            runOnWorktreeSettle: true,
            keybinding: "cmd+x",
          },
        ],
      }),
    ),
  ).toEqual([{ name: "Test", command: "npm run test", icon: "play" }]);
});
it("rejects broken templates instead of partially importing them", () => {
  expect(() => parseProjectFileScripts('{"scripts":[{"name":"x","command":1}]}')).toThrow();
  expect(() => parseProjectFileScripts("invalid")).toThrow();
});
