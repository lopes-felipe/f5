function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept partial/legacy settings without materializing defaults or losing unknown keys. */
export function redactBackupSettings(input: unknown): Record<string, unknown> {
  const settings = record(structuredClone(input));
  if (!settings) throw new Error("Backup settings must contain a JSON object.");
  const opencode = record(record(settings.providers)?.opencode);
  if (opencode && "serverPassword" in opencode) opencode.serverPassword = "";
  for (const value of Object.values(record(settings.providerInstances) ?? {})) {
    const instance = record(value);
    if (!instance) continue;
    const config = record(instance.config);
    if (config && "serverPassword" in config) config.serverPassword = "";
    if (!Array.isArray(instance.environment)) continue;
    for (const entry of instance.environment) {
      const variable = record(entry);
      if (
        variable &&
        (variable.sensitive === true ||
          (typeof variable.name === "string" &&
            /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(variable.name)))
      ) {
        variable.value = "";
        variable.valueRedacted = true;
      }
    }
  }
  return settings;
}
