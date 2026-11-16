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
  if (value === undefined) return "";
  if (field.format) return JSON.stringify(value);
  return typeof value === "string" ? value : "";
}
