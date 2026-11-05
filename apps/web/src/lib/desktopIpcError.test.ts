import { expect, it } from "vitest";
import { desktopIpcErrorMessage } from "./desktopIpcError";

it("strips Electron's IPC channel prefix from main-process errors", () => {
  expect(
    desktopIpcErrorMessage(
      new Error(
        "Error invoking remote method 'desktop:reveal-file': Error: The file /x does not exist.",
      ),
      "fallback",
    ),
  ).toBe("The file /x does not exist.");
  expect(desktopIpcErrorMessage(new Error("File manager is unavailable."), "fallback")).toBe(
    "File manager is unavailable.",
  );
  expect(desktopIpcErrorMessage("not an error", "fallback")).toBe("fallback");
});
