import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

export const colors = {
  background: "#10141c",
  surface: "#1a2130",
  text: "#f2f5fc",
  muted: "#aab8ce",
  border: "#344057",
  accent: "#a9caff",
  accentText: "#09182c",
  danger: "#ffb5b8",
};
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 16 },
  title: { color: colors.text, fontSize: 27, fontWeight: "700" },
  heading: { color: colors.text, fontSize: 18, fontWeight: "700" },
  text: { color: colors.text, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  alert: { color: colors.danger, fontSize: 15, lineHeight: 21 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 8,
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  field: {
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    fontSize: 16,
    padding: 12,
    minHeight: 48,
  },
  button: {
    borderRadius: 10,
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  quiet: { backgroundColor: colors.surface, borderColor: colors.border },
  buttonLabel: { color: colors.accentText, fontWeight: "700", fontSize: 15 },
});

export function Action({
  label,
  onPress,
  disabled,
  quiet,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean | undefined;
  quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        quiet && styles.quiet,
        { opacity: disabled ? 0.5 : pressed ? 0.77 : 1 },
      ]}
    >
      <Text style={[styles.buttonLabel, quiet && { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps) {
  return (
    <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.field, props.style]} />
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      {title && (
        <Text accessibilityRole="header" style={styles.heading}>
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}

export function Waiting() {
  return (
    <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
