import { useRouter } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, SectionList, Text, Pressable, View } from "react-native";
import type { MobileThreadShell } from "@t3tools/contracts/mobile/v1";
import { useMobileModel } from "../src/core/model";
import { mobileSync } from "../src/core/sync";
import { Action, colors, styles, Waiting } from "../src/ui";

type Thread = typeof MobileThreadShell.Type;
const connectionLabels = {
  connecting: "Connecting to F5…",
  syncing: "Syncing with F5…",
  ready: "",
  offline: "Host offline. Check Tailscale and make sure your host is awake.",
  revoked: "Access revoked. Pair again to connect.",
  "access-off": "Phone access is off on the host.",
  "update-required": "Update F5 on the host or your phone to connect.",
  "rate-limited": "Too many attempts. F5 will retry when the limit expires.",
  "identity-changed": "The server identity changed. Pair again from the host.",
} as const;

function attention(thread: Thread) {
  const { pendingApprovalRequestIds, pendingInputRequestIds, planReady, latestFailedTurnId } =
    thread.attention;
  if (pendingApprovalRequestIds.length) return { label: "Approval needed", order: 0 };
  if (pendingInputRequestIds.length) return { label: "Answer needed", order: 1 };
  if (thread.workflowRole) return null;
  if (planReady) return { label: "Plan ready", order: 2 };
  if (latestFailedTurnId) return { label: "Turn failed", order: 3 };
  return null;
}

export default function Home() {
  const router = useRouter();
  const { loaded, server, shell, status, syncTimedOut } = useMobileModel();
  const sections = useMemo(() => {
    const now = Date.now();
    const threads = (shell?.threads ?? [])
      .filter(
        (thread) =>
          !thread.archivedAt &&
          !thread.settledAt &&
          !thread.isSideChat &&
          (!thread.snoozedUntil || Date.parse(thread.snoozedUntil) <= now) &&
          (!thread.workflowRole || attention(thread)),
      )
      .slice()
      .sort(
        (left, right) =>
          right.latestActivityAt.localeCompare(left.latestActivityAt) ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
    const needs: Thread[] = [];
    const working: Thread[] = [];
    const recent: Thread[] = [];
    for (const thread of threads) {
      if (attention(thread)) needs.push(thread);
      else if (thread.sessionStatus === "running" || thread.sessionStatus === "connecting")
        working.push(thread);
      else recent.push(thread);
    }
    needs.sort((a, b) => (attention(a)?.order ?? 0) - (attention(b)?.order ?? 0));
    return [
      { title: "Needs you", data: needs },
      { title: "Working", data: working },
      { title: "Recent", data: recent },
    ].filter(({ data }) => data.length > 0);
  }, [shell]);
  const projectNames = useMemo(
    () => new Map(shell?.projects.map((project) => [project.id, project.name])),
    [shell],
  );

  if (!loaded) return <Waiting />;
  if (!server)
    return (
      <View style={[styles.screen, styles.content, { justifyContent: "center" }]}>
        <Text style={styles.title}>Connect to F5</Text>
        <Text style={styles.muted}>
          On your F5 host, open Settings → Phone access to pair over Tailscale.
        </Text>
        {status === "revoked" && <Text style={styles.alert}>{connectionLabels.revoked}</Text>}
        <Action
          label={status === "revoked" ? "Pair again" : "Pair a phone"}
          onPress={() => router.push("/pair")}
        />
      </View>
    );
  const banner = syncTimedOut ? "Still syncing" : connectionLabels[status];
  return (
    <SectionList<Thread, { title: string }>
      style={styles.screen}
      contentContainerStyle={[styles.content, { flexGrow: 1 }]}
      stickySectionHeadersEnabled={false}
      sections={sections}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={status === "syncing" && !syncTimedOut}
          onRefresh={mobileSync.retry}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={styles.between}>
            <Text style={[styles.title, { flexShrink: 1 }]}>{server.profileName}</Text>
            <Action label="Settings" quiet onPress={() => router.push("/settings")} />
          </View>
          {banner && (
            <View style={styles.card}>
              <Text accessibilityLiveRegion="polite" style={styles.muted}>
                {banner}
              </Text>
              {status !== "connecting" && (status !== "syncing" || syncTimedOut) && (
                <Action label="Retry" quiet onPress={mobileSync.retry} />
              )}
            </View>
          )}
        </View>
      }
      ListEmptyComponent={() =>
        status === "ready" ? <Text style={styles.muted}>No active conversations.</Text> : null
      }
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" style={[styles.heading, { marginVertical: 8 }]}>
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          style={[styles.card, { marginBottom: 8 }]}
          onPress={() =>
            router.push({
              pathname: "/thread/[serverId]/[threadId]",
              params: { serverId: server.serverId, threadId: item.id },
            })
          }
        >
          {item.projectId && <Text style={styles.muted}>{projectNames.get(item.projectId)}</Text>}
          <Text style={styles.text} numberOfLines={2}>
            {item.title}
          </Text>
          {attention(item) && (
            <Text style={{ color: colors.accent, fontWeight: "600" }}>
              {attention(item)?.label}
            </Text>
          )}
        </Pressable>
      )}
    />
  );
}
