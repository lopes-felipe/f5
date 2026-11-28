import { applicationId } from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { mobileSync } from "./core/sync";
import { useMobileModel } from "./core/model";

export const pushAvailable = Constants.expoConfig?.extra?.push === true && Platform.OS === "ios";

export async function registerPushToken(requestPermission = false) {
  if (!pushAvailable || !applicationId) return;
  const server = useMobileModel.getState().server;
  if (!server) return;
  let { granted } = await Notifications.getPermissionsAsync();
  if (!granted && requestPermission) ({ granted } = await Notifications.requestPermissionsAsync());
  if (!granted) return;
  // The ready effect covers grants that complete before the socket is ready.
  // A grant that completes after welcome also reaches this registration path.
  if (useMobileModel.getState().server !== server || useMobileModel.getState().status !== "ready")
    return;
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== "string") return;
  if (useMobileModel.getState().server !== server || useMobileModel.getState().status !== "ready")
    return;
  const environment =
    Constants.expoConfig?.extra?.pushEnvironment === "sandbox" ? "sandbox" : "production";
  await mobileSync.rpc("registerPush", {
    pushToken: token.data,
    bundleId: applicationId,
    environment,
  });
}
