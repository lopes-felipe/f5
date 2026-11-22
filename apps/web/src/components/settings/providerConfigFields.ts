import { AcpSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import type { DriverFieldDef } from "./providerDriverMeta";

export function decodeDriverConfigField(field: DriverFieldDef, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    if (field.required) throw new Error(`${field.label} is required.`);
    return undefined;
  }
  if (!field.format) return trimmed;
  try {
    const value: unknown = JSON.parse(trimmed);
    return field.format === "json-array"
      ? Schema.decodeUnknownSync(AcpSettings.fields.args)(value)
      : Schema.decodeUnknownSync(AcpSettings.fields.env)(value);
  } catch {
    throw new Error(
      field.format === "json-array"
        ? `${field.label} must be a JSON array of arguments.`
        : `${field.label} must be a JSON object with environment variable names and string values.`,
    );
  }
}
export function readDriverConfigField(config: unknown, field: DriverFieldDef): string {
  if (!config || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[field.key];
  if (value === undefined) return field.defaultValue ?? "";
  if (field.format) return JSON.stringify(value);
  return typeof value === "string" ? value : "";
}

/** Whether a field applies to the instance's current config (conditional fields). */
export function isDriverConfigFieldVisible(
  config: unknown,
  field: DriverFieldDef,
  fields: ReadonlyArray<DriverFieldDef>,
): boolean {
  if (!field.visibleWhen) return true;
  const controller = fields.find((candidate) => candidate.key === field.visibleWhen!.key);
  const value = controller
    ? readDriverConfigField(config, controller)
    : readDriverConfigField(config, { key: field.visibleWhen.key, label: "" });
  return value === field.visibleWhen.equals;
}

/** A stored secret exists for this field (its value is never sent to the browser). */
export function hasStoredDriverSecret(config: unknown, field: DriverFieldDef): boolean {
  if (!field.redactedKey || !config || typeof config !== "object") return false;
  return (config as Record<string, unknown>)[field.redactedKey] === true;
}
