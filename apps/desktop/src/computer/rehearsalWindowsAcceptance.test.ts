import { expect, it } from "vitest";
import type { ComputerDisplay, ComputerScreenshot } from "@t3tools/contracts";
import { captureRect } from "./rehearseCaptureWindows";
import { displayReceiptsMatch } from "./rehearseDisplaysWindows";
import {
  expectWindowsRefusal,
  WindowsRefusalMismatch,
  type WindowReceipt,
} from "./rehearsalWindowsAcceptance";
import { ComputerControlError } from "@t3tools/shared/computerControl";

const display: ComputerDisplay = {
  displayId: "secondary",
  geometryGeneration: "g1",
  primary: false,
  rotation: 0,
  nativeBounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  pixelSize: { width: 1920, height: 1080 },
  modelSize: { width: 960, height: 540 },
};
const image: ComputerScreenshot = {
  displayId: "secondary",
  geometryGeneration: "g1",
  modelSize: { width: 960, height: 540 },
  mimeType: "image/jpeg",
  data: "in-memory",
  hiddenContent: true,
};
it("maps physical password bounds through negative origins, downscaling and zoom", () => {
  const secure = { x: -1820, y: -100, width: 400, height: 40 };
  expect(captureRect(secure, display, image)).toEqual({ x: 50, y: 50, width: 200, height: 20 });
  const zoom = {
    ...image,
    mimeType: "image/png" as const,
    modelSize: { width: 420, height: 80 },
    rect: { x: 45, y: 40, width: 210, height: 40 },
  };
  expect(captureRect(secure, display, zoom)).toEqual({ x: 10, y: 20, width: 400, height: 40 });
});
it("does not accept a helper-only topology claim when fixture geometry or rotation disagrees", () => {
  const receipt = {
    displays: [{ displayId: "secondary", bounds: display.nativeBounds, rotation: 0 }],
  } as WindowReceipt;
  expect(displayReceiptsMatch([display], receipt)).toBe(true);
  expect(displayReceiptsMatch([{ ...display, rotation: 90 }], receipt)).toBe(false);
  expect(
    displayReceiptsMatch(
      [{ ...display, nativeBounds: { ...display.nativeBounds, x: 0 } }],
      receipt,
    ),
  ).toBe(false);
  expect(displayReceiptsMatch([], receipt)).toBe(false);
});
it("requires the exact refusal and records only safe tags for mismatches", async () => {
  await expect(
    expectWindowsRefusal(async () => {
      throw new ComputerControlError({ _tag: "NotGranted", needed: "view" });
    }, "NotGranted"),
  ).resolves.toBeUndefined();
  const mismatch = await expectWindowsRefusal(async () => {
    throw new ComputerControlError({
      _tag: "ForegroundRequired",
      reason: "window-unavailable",
    });
  }, "NotGranted").catch((error: unknown) => error);
  expect(mismatch).toBeInstanceOf(WindowsRefusalMismatch);
  expect(mismatch).toMatchObject({
    expected: "NotGranted",
    actual: { code: "ForegroundRequired", reason: "window-unavailable" },
  });
  const privateFailure = await expectWindowsRefusal(async () => {
    throw new Error("PRIVATE_CAPTURE_SENTINEL C:\\private\\image.png");
  }, "NotGranted").catch((error: unknown) => error);
  expect(privateFailure).toBeInstanceOf(WindowsRefusalMismatch);
  expect(JSON.stringify(privateFailure)).not.toContain("PRIVATE_CAPTURE_SENTINEL");
  await expect(expectWindowsRefusal(async () => {}, "NotGranted")).rejects.toThrow(
    "expected-refusal-missing",
  );
});
