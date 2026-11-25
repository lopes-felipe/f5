import { Option, Schema } from "effect";
import type { DriverFieldDef } from "./providerDriverMeta";

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function decodeDriverConfigField(field: DriverFieldDef, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    if (field.required) throw new Error(`${field.label} is required.`);
    if (field.format !== "number") return undefined;
  }
  if (field.format === "json-array" || field.format === "json-record") {
    try {
      return Schema.decodeUnknownSync(field.schema)(JSON.parse(trimmed));
    } catch {
      throw new Error(
        field.format === "json-array"
          ? `${field.label} must be a JSON array of arguments.`
          : `${field.label} must be a JSON object with environment variable names and string values.`,
      );
    }
  }
  const value =
    field.format === "number"
      ? !trimmed || DECIMAL_NUMBER.test(trimmed)
        ? Number(trimmed)
        : NaN
      : trimmed;
  if (Option.isNone(Schema.decodeUnknownOption(field.schema)(value))) {
    throw new Error("Enter a valid value. It was not saved.");
  }
  return value;
}

function readConfigValue(config: unknown, key: string): unknown {
  return config && typeof config === "object"
    ? (config as Record<string, unknown>)[key]
    : undefined;
}

export function readDriverConfigField(config: unknown, field: DriverFieldDef): string {
  if (!config || typeof config !== "object") return "";
  const value = readConfigValue(config, field.key);
  if (value === undefined) return field.defaultValue ?? "";
  if (field.format === "number") return String(value);
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
  const { key, equals } = field.visibleWhen;
  const controller = fields.find((candidate) => candidate.key === key);
  const value = controller
    ? readDriverConfigField(config, controller)
    : readConfigValue(config, key);
  return value === equals;
}

/** A stored secret exists for this field (its value is never sent to the browser). */
export function hasStoredDriverSecret(config: unknown, field: DriverFieldDef): boolean {
  if (!field.redactedKey || !config || typeof config !== "object") return false;
  return (config as Record<string, unknown>)[field.redactedKey] === true;
}
