import type { ExpoConfig } from "expo/config";
import { APP_BUNDLE_ID } from "../../packages/shared/src/appIdentity.ts";
import { version } from "./package.json";

const development = process.env.F5_MOBILE_VARIANT === "development";
const push = process.env.F5_IOS_PERSONAL_TEAM !== "1";
const bundleIdentifier =
  process.env.F5_IOS_BUNDLE_ID ?? APP_BUNDLE_ID + ".mobile" + (development ? ".dev" : "");

const config: ExpoConfig = {
  name: development ? "F5 Dev" : "F5",
  slug: "f5-mobile",
  scheme: development ? ["f5-dev", "f5"] : "f5",
  version,
  orientation: "portrait",
  icon: "../../assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier,
    supportsTablet: false,
    buildNumber: process.env.F5_IOS_BUILD_NUMBER ?? "1",
    ...(push
      ? {
          entitlements: {
            "aps-environment": development ? "development" : "production",
          },
        }
      : {}),
    infoPlist: {
      NSLocalNetworkUsageDescription: "Connect to your F5 host over Tailscale.",
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
          "100.64.0.0/10": { NSExceptionAllowsInsecureHTTPLoads: true },
          "fd7a:115c:a1e0::/48": { NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-camera", { cameraPermission: "Scan an F5 pairing code.", recordAudioAndroid: false }],
    ["expo-build-properties", { ios: { deploymentTarget: "17.0" } }],
    ...(push ? ["expo-notifications"] : []),
    "./plugins/withPushEntitlement.cjs",
  ],
  extra: { push, pushEnvironment: development ? "sandbox" : "production" },
};

export default config;
