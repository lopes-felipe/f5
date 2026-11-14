import { readAppSettingsSnapshot, subscribeAppSettings } from "../appSettings";
import { getPrHubSelectedAccountId, setPrHubSelectedAccountId } from "./prHubAccount";

/**
 * Applies the saved forge account choice and follows later changes, calling `onChange`
 * after each switch. Runs once at startup, so the choice is in place before anything
 * renders and no component has to write it while rendering.
 */
export function followPrHubAccountSetting(onChange: () => void): () => void {
  const apply = () => {
    const next = readAppSettingsSnapshot().prHubAccountId ?? undefined;
    if (next === getPrHubSelectedAccountId()) return;
    setPrHubSelectedAccountId(next);
    onChange();
  };
  apply();
  return subscribeAppSettings(apply);
}
