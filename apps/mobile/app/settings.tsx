import { nativeApplicationVersion } from "expo-application";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text } from "react-native";
import { useMobileModel } from "../src/core/model";
import { mobileSync } from "../src/core/sync";
import { pushAvailable, registerPushToken } from "../src/notifications";
import { Action, Card, styles } from "../src/ui";

export default function Settings() {
  const router = useRouter();
  const { server, info, status } = useMobileModel();
  const [notice, setNotice] = useState("");
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card title="Paired host">
        <Text style={styles.text}>{server?.profileName ?? "No paired host"}</Text>
        {server && (
          <Text selectable style={styles.muted}>
            {server.origins[0]}
          </Text>
        )}
        {server && (
          <Action
            label="Forget server"
            quiet
            onPress={() =>
              Alert.alert(
                "Forget this server?",
                "Pair this phone again to reconnect to the host.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Forget",
                    style: "destructive",
                    onPress: () => {
                      void mobileSync.forgetServer().then(
                        () => router.replace("/"),
                        () => setNotice("Could not forget the server."),
                      );
                    },
                  },
                ],
              )
            }
          />
        )}
      </Card>
      <Card title="Notifications">
        <Text style={styles.muted}>
          {pushAvailable
            ? "Get alerts for approvals, questions, failed turns and plans ready to implement. Push delivery pauses while the host sleeps."
            : "Push notifications are unavailable in this build."}
        </Text>
        {pushAvailable && (
          <Action
            label="Register for notifications"
            quiet
            disabled={status !== "ready"}
            onPress={() =>
              void registerPushToken(true).then(
                () => setNotice("Check notification permission in iOS Settings."),
                () => setNotice("Registration failed. Check the host’s APNs configuration."),
              )
            }
          />
        )}
      </Card>
      <Card title="About">
        <Text selectable style={styles.muted}>
          App {nativeApplicationVersion ?? "0.1.0"}
        </Text>
        {info && (
          <Text selectable style={styles.muted}>
            Host {info.serverVersion} · Mobile API {info.mobileApi.current}
          </Text>
        )}
        <Text selectable style={styles.muted}>
          Connection {status}
        </Text>
      </Card>
      {notice && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {notice}
        </Text>
      )}
    </ScrollView>
  );
}
