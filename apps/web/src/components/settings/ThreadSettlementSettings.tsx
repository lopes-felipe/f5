import type { ReactNode } from "react";
import type { ServerSettings } from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { RetentionDaysInput } from "./WorktreeCleanupRulesEditor";
import { SettingsCard, SettingsRow } from "./SettingsCard";
export type SettlementSettings = Pick<
  ServerSettings,
  "autoSettleOnPullRequestMerge" | "autoSettleAfterDays" | "autoSettleKeepPullRequests"
>;
export function ThreadSettlementFields(props: {
  settings: SettlementSettings;
  disabled?: boolean;
  onChange: (patch: Partial<SettlementSettings>) => void;
  badge?: (key: keyof SettlementSettings) => ReactNode;
}) {
  return (
    <>
      <SettingsRow
        title={<>Settle resolved pull requests {props.badge?.("autoSettleOnPullRequestMerge")}</>}
        description="Settle an idle thread when every linked PR is merged or closed after the last human message or wake."
        control={
          <Switch
            aria-label="Automatically settle resolved PR threads"
            disabled={props.disabled ?? false}
            checked={props.settings.autoSettleOnPullRequestMerge}
            onCheckedChange={(value) => props.onChange({ autoSettleOnPullRequestMerge: value })}
          />
        }
      />
      <SettingsRow
        title={<>Settle idle threads after {props.badge?.("autoSettleAfterDays")}</>}
        description="Leave empty to keep idle threads active. Between 1 and 365 days."
        control={
          <RetentionDaysInput
            label="Automatically settle idle threads after"
            maxDays={365}
            value={props.settings.autoSettleAfterDays}
            disabled={props.disabled ?? false}
            onCommit={(value) => props.onChange({ autoSettleAfterDays: value })}
          />
        }
      />
      <SettingsRow
        title={<>Keep threads with linked PRs {props.badge?.("autoSettleKeepPullRequests")}</>}
        description="Keep PR threads active when the inactivity rule applies."
        control={
          <Switch
            aria-label="Keep linked PR threads active"
            disabled={props.disabled ?? false}
            checked={props.settings.autoSettleKeepPullRequests}
            onCheckedChange={(value) => props.onChange({ autoSettleKeepPullRequests: value })}
          />
        }
      />
    </>
  );
}
export function ThreadSettlementSettings() {
  const settings = useSettings((value) => value);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsCard
      title="Thread settlement"
      description="Keep completed work without archiving it. Automatic settlement is off by default."
      searchTarget="git.settlement"
    >
      <ThreadSettlementFields
        settings={settings}
        onChange={(patch) => {
          void updateSettings(patch).catch(() =>
            toastManager.add({ type: "error", title: "Could not save settlement settings" }),
          );
        }}
      />
    </SettingsCard>
  );
}
