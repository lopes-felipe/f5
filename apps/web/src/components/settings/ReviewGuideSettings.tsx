import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ModelSelection } from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { SettingsCard, SettingsRow } from "./SettingsCard";
import { Switch } from "../ui/switch";
import { GenerationModelPicker } from "./GenerationModelPicker";

export function ReviewGuideSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const config = useQuery(serverConfigQueryOptions());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const selection = settings.reviewGuideModelSelection ?? settings.textGenerationModelSelection;
  const save = async (next: ModelSelection | null) => {
    setSaving(true);
    setFailed(false);
    try {
      await updateSettings({ reviewGuideModelSelection: next });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title="Guided PR reviews"
      searchTarget="git.review-guide-model"
      description="Generate a review tour from the PR description and diff using this provider's account."
    >
      <SettingsRow
        title="Use git text generation model"
        description="Turn off to choose a separate review guide model."
        control={
          <Switch
            aria-label="Use git text generation model for review guides"
            checked={settings.reviewGuideModelSelection === null}
            disabled={saving}
            onCheckedChange={(value) => void save(value ? null : selection)}
          />
        }
      />
      <GenerationModelPicker
        value={selection}
        providers={config.data?.providers ?? []}
        disabled={saving || settings.reviewGuideModelSelection === null}
        onChange={(value) => void save(value)}
      />
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          Could not save review guide settings. Try again.
        </p>
      ) : null}
    </SettingsCard>
  );
}
