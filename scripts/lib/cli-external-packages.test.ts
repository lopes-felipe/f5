import { expect, it } from "vitest";
import { selectCliRuntimeExternalDependencies } from "./cli-external-packages";
it("stages native runtime roots while bundling ordinary server dependencies", () => {
  expect(
    selectCliRuntimeExternalDependencies({
      "node-pty": "1",
      "@ff-labs/fff-node": "2",
      "@anthropic-ai/claude-agent-sdk": "3",
      effect: "4",
      ws: "5",
    }),
  ).toEqual({ "node-pty": "1", "@ff-labs/fff-node": "2", "@anthropic-ai/claude-agent-sdk": "3" });
});
