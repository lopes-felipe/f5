import { applicationId, nativeApplicationVersion } from "expo-application";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import { useLinkingURL } from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Modal, Platform, ScrollView, Text, View } from "react-native";
import { manualPairing, parsePairingUrl, type PairingAddress } from "../src/core/pairing";
import { mobileSync } from "../src/core/sync";
import { MobileConnectionError, MobileRpcError, pairPhone } from "../src/core/wsClient";
import { pushAvailable, registerPushToken } from "../src/notifications";
import { Action, Card, Field, styles } from "../src/ui";

export default function Pair() {
  const router = useRouter();
  const link = useLinkingURL();
  const seenLink = useRef<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [origin, setOrigin] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState(Platform.OS === "ios" ? "iPhone" : "Android phone");
  const [candidate, setCandidate] = useState<PairingAddress | null>(null);
  const [problem, setProblem] = useState("");
  const [pairing, setPairing] = useState(false);
  const [retryAt, setRetryAt] = useState(0);

  function review(parse: () => PairingAddress) {
    try {
      setCandidate(parse());
      setProblem("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Check the pairing code.");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (link && link.startsWith("f5://pair?") && seenLink.current !== link) {
      seenLink.current = link;
      review(() => parsePairingUrl(link));
    }
  }, [link]);

  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  async function pair() {
    if (!candidate || pairing || retryAt) return;
    setPairing(true);
    setProblem("");
    try {
      const paired = await pairPhone(candidate, {
        deviceName: name.trim() || "Phone",
        platform: Platform.OS === "android" ? "android" : "ios",
        appVersion: nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0.1.0",
        bundleId: applicationId ?? "io.github.lopesfelipe.f5.mobile",
      });
      await mobileSync.setServer(paired);
      if (pushAvailable) void registerPushToken(true).catch(() => {});
      router.replace("/");
    } catch (error) {
      if (error instanceof MobileConnectionError && error.state === "rate-limited") {
        setRetryAt(error.retryAt);
        setProblem("Too many attempts. Wait and try again.");
      } else if (error instanceof MobileRpcError && error.code === "http-401") {
        setProblem("This pairing code expired or was used. Generate a new code on the host.");
      } else if (error instanceof MobileConnectionError && error.state === "identity-changed") {
        setProblem("The address belongs to a different F5 server. Use a new code from your host.");
      } else if (error instanceof MobileConnectionError && error.state === "update-required") {
        setProblem("Update F5 to a compatible version before pairing.");
      } else {
        setProblem("Could not pair. Check Tailscale and the address shown in Phone access.");
      }
    } finally {
      setPairing(false);
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Pair with your host</Text>
      <Text style={styles.muted}>Open F5 Settings → Phone access, then choose Pair a phone.</Text>
      {scanning ? (
        <View style={{ height: 270, overflow: "hidden", borderRadius: 14 }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => review(() => parsePairingUrl(data))}
          />
        </View>
      ) : (
        <Action
          label="Scan QR code"
          onPress={() => {
            void (permission?.granted ? Promise.resolve(permission) : requestPermission()).then(
              (result) => {
                if (result.granted) setScanning(true);
                else setProblem("Allow camera access or enter the origin and code below.");
              },
            );
          }}
        />
      )}
      {scanning && <Action label="Close scanner" quiet onPress={() => setScanning(false)} />}
      <Card title="Enter pairing details">
        <Text style={styles.muted}>Server origin</Text>
        <Field
          accessibilityLabel="Server origin"
          value={origin}
          onChangeText={setOrigin}
          placeholder="http://my-host.tailnet.ts.net:37730"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.muted}>Pairing code</Text>
        <Field
          accessibilityLabel="Pairing code"
          value={code}
          onChangeText={setCode}
          maxLength={10}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Text style={styles.muted}>Device name</Text>
        <Field
          accessibilityLabel="Device name"
          value={name}
          onChangeText={setName}
          maxLength={128}
        />
        <Action
          label="Review pairing"
          quiet
          onPress={() => review(() => manualPairing(origin, code))}
        />
      </Card>
      {!candidate && problem && (
        <Text accessibilityLiveRegion="polite" style={styles.alert}>
          {problem}
        </Text>
      )}
      <Modal
        visible={candidate !== null}
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!pairing) setCandidate(null);
        }}
      >
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
          <Text style={styles.title}>Confirm pairing</Text>
          <Text style={styles.text}>{candidate?.profileName ?? "F5 server"}</Text>
          {candidate?.origins.map((address) => (
            <Text key={address} selectable style={styles.muted}>
              {address}
            </Text>
          ))}
          <Text style={styles.muted}>
            Check that this address matches Phone access on your host.
          </Text>
          {problem && (
            <Text accessibilityLiveRegion="polite" style={styles.alert}>
              {problem}
            </Text>
          )}
          <Action
            label={pairing ? "Pairing…" : "Confirm and pair"}
            disabled={pairing || retryAt > 0}
            onPress={() => void pair()}
          />
          <Action
            label="Cancel"
            quiet
            disabled={pairing}
            onPress={() => {
              setCandidate(null);
              setProblem("");
            }}
          />
        </ScrollView>
      </Modal>
    </ScrollView>
  );
}
