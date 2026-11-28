import { afterEach, expect, it, vi } from "vitest";
import { registerPushToken } from "./notifications";
import { initialModel, useMobileModel } from "./core/model";

const native = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), token: vi.fn(), rpc: vi.fn() }));
vi.mock("expo-application", () => ({ applicationId: "test.f5.mobile" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { push: true } } } }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: native.get,
  requestPermissionsAsync: native.request,
  getDevicePushTokenAsync: native.token,
}));
vi.mock("./core/sync", () => ({ mobileSync: { rpc: native.rpc } }));
afterEach(() => {
  useMobileModel.setState(initialModel);
  vi.resetAllMocks();
});

it("registers immediately when a delayed permission grant arrives after the connection is ready", async () => {
  const permission = Promise.withResolvers<{ granted: boolean }>();
  useMobileModel.setState({
    server: {
      origins: ["http://100.64.1.2"],
      serverId: "server",
      deviceId: "device",
      deviceToken: "token",
      profileName: "Test",
      deviceName: "Phone",
    },
    status: "connecting",
  });
  native.get.mockResolvedValue({ granted: false });
  native.request.mockReturnValue(permission.promise);
  native.token.mockResolvedValue({ data: "a".repeat(64) });
  const pending = registerPushToken(true);
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
  useMobileModel.setState({ status: "ready" });
  await registerPushToken();
  expect(native.rpc).not.toHaveBeenCalled();
  permission.resolve({ granted: true });
  await pending;
  expect(native.rpc).toHaveBeenCalledWith("registerPush", {
    pushToken: "a".repeat(64),
    bundleId: "test.f5.mobile",
    environment: "production",
  });
});
