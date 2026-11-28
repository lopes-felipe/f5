import { Stack, useRouter } from "expo-router";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState, StatusBar, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useMobileModel } from "../src/core/model";
import { mobileSync } from "../src/core/sync";
import { pushAvailable, registerPushToken } from "../src/notifications";
import { colors } from "../src/ui";

export default function RootLayout() {
  const router = useRouter();
  const loaded = useMobileModel((state) => state.loaded);
  const active = useMobileModel((state) => state.active);
  const status = useMobileModel((state) => state.status);
  const serverId = useMobileModel((state) => state.server?.serverId);
  const info = useMobileModel((state) => state.info);
  const selected = useMobileModel((state) => state.selected);

  useEffect(() => {
    const app = AppState.addEventListener("change", (state) =>
      mobileSync.active(state === "active"),
    );
    if (AppState.currentState) mobileSync.active(AppState.currentState === "active");
    void mobileSync.load();
    const network = Network.addNetworkStateListener((state) => {
      if (state.isConnected) mobileSync.networkChanged();
    });
    return () => {
      app.remove();
      network.remove();
    };
  }, []);

  useEffect(() => {
    if (!loaded || !pushAvailable) return;
    function open(response: Notifications.NotificationResponse) {
      const data = response.notification.request.content.data?.f5 as
        | { serverId?: unknown; threadId?: unknown }
        | undefined;
      if (data && data.serverId === serverId && serverId && typeof data.threadId === "string") {
        router.push({
          pathname: "/thread/[serverId]/[threadId]",
          params: { serverId, threadId: data.threadId },
        });
        Notifications.clearLastNotificationResponse();
      }
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    const previous = Notifications.getLastNotificationResponse();
    if (previous) open(previous);
    return () => subscription.remove();
  }, [loaded, router, serverId]);

  useEffect(() => {
    if (active && info && status === "ready" && pushAvailable)
      void registerPushToken().catch(() => {});
  }, [active, info, status]);

  useEffect(() => {
    if (status !== "ready" || !active) return;
    void mobileSync.presence();
    const timer = setInterval(() => void mobileSync.presence(), 10_000);
    return () => clearInterval(timer);
  }, [active, selected, status]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.accent,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: "F5" }} />
          <Stack.Screen name="pair" options={{ title: "Pair a phone" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="thread/[serverId]/[threadId]" options={{ title: "Conversation" }} />
        </Stack>
        {!active && (
          <View
            accessibilityElementsHidden
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}
          />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
