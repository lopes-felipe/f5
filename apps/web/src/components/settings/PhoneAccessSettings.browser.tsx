import "../../index.css";
import { DEFAULT_SERVER_SETTINGS, WS_METHODS } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PhoneAccessSettings } from "./PhoneAccessSettings";

const request = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    selector(DEFAULT_SERVER_SETTINGS),
}));
vi.mock("../../wsNativeApi", () => ({
  phoneAccessTransport: () => ({ request, subscribe: () => () => {} }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));

beforeEach(() => {
  request.mockReset().mockImplementation(async (method: string) => {
    switch (method) {
      case WS_METHODS.mobileAccessGetStatus:
        return { state: "listening", apnsKeyStored: true };
      case WS_METHODS.mobileAccessListDevices:
        return [
          {
            deviceId: "phone",
            name: "My iPhone",
            platform: "ios",
            appVersion: "0.1.0",
            lastSeenAt: "2026-11-28T10:00:00.000Z",
            pushRegistered: true,
          },
        ];
      case WS_METHODS.mobileAccessSetApnsConfig:
        return { configured: true };
      case WS_METHODS.mobileAccessRenameDevice:
        return true;
      default:
        throw new Error("Unexpected request " + method);
    }
  });
});

it("submits the APNs configuration and chosen key when Save is clicked", async () => {
  const view = await render(<PhoneAccessSettings />);
  try {
    await page.getByLabelText("Apple team ID").fill("TEAM123456");
    await page.getByLabelText("APNs key ID").fill("KEY1234567");
    const privateKey = page.getByLabelText("APNs private key (.p8)");
    await privateKey.upload(new File(["fixture key contents"], "AuthKey_test.p8"));
    await page.getByRole("button", { name: "Save APNs settings" }).click();

    await expect.element(page.getByRole("status")).toHaveTextContent("APNs configuration saved.");
    expect(request).toHaveBeenCalledWith(WS_METHODS.mobileAccessSetApnsConfig, {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      baseBundleId: "io.github.lopesfelipe.f5.mobile",
      privateKey: "fixture key contents",
    });
  } finally {
    await view.unmount();
  }
});

it("submits the edited device name when Rename is clicked", async () => {
  const view = await render(<PhoneAccessSettings />);
  try {
    await page.getByLabelText("Name for My iPhone").fill("Work iPhone");
    await page.getByRole("button", { name: "Rename", exact: true }).click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(WS_METHODS.mobileAccessRenameDevice, {
        deviceId: "phone",
        name: "Work iPhone",
      }),
    );
  } finally {
    await view.unmount();
  }
});
