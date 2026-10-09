import {
  ELICITATION_MAX_BYTES,
  ELICITATION_MAX_FIELDS,
  ELICITATION_MAX_OPTIONS,
  type ElicitationDescriptor,
  type ElicitationField,
  type ElicitationFieldOption,
  type ElicitationStringFormat,
  type ElicitationValue,
} from "@t3tools/contracts";

/**
 * Provider-neutral MCP elicitation form engine shared by ACP, Claude and Codex
 * adapters and by the browser. It only accepts what it can show completely:
 * every field is rendered, unsupported constraints are refused (the caller
 * cancels the request visibly) and no value is ever filled in on the user's
 * behalf. Error messages name fields, never values.
 */

export type ElicitationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const MAX_KEY_CHARS = 256;
const MAX_TEXT_CHARS = 4_000;
const FORMATS: ReadonlySet<string> = new Set(["email", "uri", "date", "date-time"]);
const COMMON_KEYS = ["type", "title", "description", "default"];
const ALLOWED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set([
    ...COMMON_KEYS,
    "minLength",
    "maxLength",
    "format",
    "enum",
    "enumNames",
    "oneOf",
  ]),
  number: new Set([...COMMON_KEYS, "minimum", "maximum"]),
  integer: new Set([...COMMON_KEYS, "minimum", "maximum"]),
  boolean: new Set(COMMON_KEYS),
  array: new Set([...COMMON_KEYS, "items", "minItems", "maxItems", "uniqueItems"]),
};
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const fail = <T>(reason: string): ElicitationResult<T> => ({ ok: false, reason });
const ok = <T>(value: T): ElicitationResult<T> => ({ ok: true, value });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function byteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    );
    return new TextEncoder().encode(json ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_CHARS) : undefined;
}

function nonNegativeInt(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  // Generated MCP types use bigint for array bounds.
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finite(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptions(
  label: string,
  field: Record<string, unknown>,
  container: Record<string, unknown>,
): ElicitationResult<ElicitationFieldOption[] | undefined> {
  let options: ElicitationFieldOption[] | undefined;
  if (Array.isArray(container.enum)) {
    const names = Array.isArray(field.enumNames) ? field.enumNames : undefined;
    options = [];
    for (const [index, value] of container.enum.entries()) {
      if (typeof value !== "string") return fail(`"${label}" has a non-text choice.`);
      const name = names?.[index];
      options.push({ value, label: typeof name === "string" && name.trim() ? name : value });
    }
  }
  const titled = Array.isArray(container.oneOf)
    ? container.oneOf
    : Array.isArray(container.anyOf)
      ? container.anyOf
      : undefined;
  if (titled) {
    if (options) return fail(`"${label}" lists its choices twice.`);
    options = [];
    for (const entry of titled) {
      const option = record(entry);
      if (typeof option?.const !== "string") return fail(`"${label}" has a non-text choice.`);
      options.push({
        value: option.const,
        label:
          typeof option.title === "string" && option.title.trim() ? option.title : option.const,
      });
    }
  }
  if (!options) return ok(undefined);
  if (!options.length) return fail(`"${label}" has no choices.`);
  // An empty answer means "not filled in" everywhere, so an empty choice could
  // never be submitted.
  if (options.some((option) => option.value === "")) return fail(`"${label}" has an empty choice.`);
  if (options.length > ELICITATION_MAX_OPTIONS) return fail(`"${label}" has too many choices.`);
  if (new Set(options.map((option) => option.value)).size !== options.length)
    return fail(`"${label}" repeats a choice.`);
  return ok(options);
}

function normalizeField(
  key: string,
  raw: unknown,
  required: boolean,
): ElicitationResult<ElicitationField> {
  const present = record(raw);
  if (!present) return fail(`Field "${key}" is not a supported input.`);
  // Decoded protocol schemas spell absent optional keys as null.
  const field = Object.fromEntries(
    Object.entries(present).filter(([, value]) => value !== null && value !== undefined),
  );
  const label = boundedText(field.title) ?? key;
  const type = field.type;
  if (typeof type !== "string" || !ALLOWED_KEYS[type])
    return fail(`"${label}" uses an unsupported input type.`);
  const unsupported = Object.keys(field).find((name) => !ALLOWED_KEYS[type]!.has(name));
  if (unsupported) return fail(`"${label}" uses the unsupported constraint "${unsupported}".`);
  const description = boundedText(field.description);
  const base = {
    key,
    title: label,
    ...(description ? { description } : {}),
    required,
  };

  if (type === "boolean") {
    if (field.default !== undefined && typeof field.default !== "boolean")
      return fail(`"${label}" has an invalid default.`);
    return ok({
      ...base,
      type: "boolean",
      ...(typeof field.default === "boolean" ? { suggestedValue: field.default } : {}),
    });
  }

  if (type === "number" || type === "integer") {
    const minimum = finite(field.minimum);
    const maximum = finite(field.maximum);
    if (minimum === null || maximum === null || (minimum ?? -Infinity) > (maximum ?? Infinity))
      return fail(`"${label}" has invalid bounds.`);
    const suggested = field.default;
    if (
      suggested !== undefined &&
      (typeof suggested !== "number" ||
        !Number.isFinite(suggested) ||
        (type === "integer" && !Number.isInteger(suggested)))
    )
      return fail(`"${label}" has an invalid default.`);
    return ok({
      ...base,
      type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(typeof suggested === "number" ? { suggestedValue: suggested } : {}),
    });
  }

  if (type === "array") {
    const items = record(field.items);
    if (!items) return fail(`"${label}" has no choices.`);
    const itemKeys = Object.keys(items).filter(
      (name) => !["type", "enum", "anyOf", "oneOf"].includes(name),
    );
    if (itemKeys.length || (items.type !== undefined && items.type !== "string"))
      return fail(`"${label}" uses an unsupported list item.`);
    if (field.uniqueItems === false) return fail(`"${label}" allows repeated choices.`);
    const options = readOptions(label, field, items);
    if (!options.ok) return options;
    if (!options.value) return fail(`"${label}" has no choices.`);
    const minItems = nonNegativeInt(field.minItems);
    const maxItems = nonNegativeInt(field.maxItems);
    if (minItems === null || maxItems === null || (minItems ?? 0) > (maxItems ?? Infinity))
      return fail(`"${label}" has invalid bounds.`);
    const suggested = field.default;
    if (
      suggested !== undefined &&
      (!Array.isArray(suggested) ||
        suggested.some(
          (value) =>
            typeof value !== "string" || !options.value!.some((option) => option.value === value),
        ))
    )
      return fail(`"${label}" has an invalid default.`);
    return ok({
      ...base,
      type: "multiselect",
      options: options.value,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(Array.isArray(suggested) ? { suggestedValue: suggested as string[] } : {}),
    });
  }

  // string
  const options = readOptions(label, field, field);
  if (!options.ok) return options;
  if (field.enumNames !== undefined && !Array.isArray(field.enum))
    return fail(`"${label}" names choices it does not list.`);
  if (
    field.format !== undefined &&
    (typeof field.format !== "string" || !FORMATS.has(field.format))
  )
    return fail(`"${label}" uses an unsupported format.`);
  const minLength = nonNegativeInt(field.minLength);
  const maxLength = nonNegativeInt(field.maxLength);
  if (minLength === null || maxLength === null || (minLength ?? 0) > (maxLength ?? Infinity))
    return fail(`"${label}" has invalid bounds.`);
  const suggested = field.default;
  if (
    suggested !== undefined &&
    (typeof suggested !== "string" ||
      (options.value && !options.value.some((option) => option.value === suggested)))
  )
    return fail(`"${label}" has an invalid default.`);
  if (options.value) {
    if (field.format !== undefined || minLength !== undefined || maxLength !== undefined)
      return fail(`"${label}" combines choices with text constraints.`);
    return ok({
      ...base,
      type: "enum",
      options: options.value,
      ...(typeof suggested === "string" ? { suggestedValue: suggested } : {}),
    });
  }
  return ok({
    ...base,
    type: "string",
    ...(typeof field.format === "string"
      ? { format: field.format as ElicitationStringFormat }
      : {}),
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(typeof suggested === "string" ? { suggestedValue: suggested } : {}),
  });
}

/** Normalizes an MCP `requestedSchema`; refuses anything it cannot render completely. */
export function normalizeElicitationSchema(
  schema: unknown,
): ElicitationResult<ReadonlyArray<ElicitationField>> {
  const form = record(schema);
  if (!form || (form.type !== undefined && form.type !== "object"))
    return fail("The form is not an object schema.");
  if (byteLength(form) > ELICITATION_MAX_BYTES) return fail("The form is too large.");
  const unsupported = Object.keys(form).find(
    (name) => !["$schema", "type", "properties", "required", "title", "description"].includes(name),
  );
  if (unsupported) return fail(`The form uses the unsupported constraint "${unsupported}".`);
  const properties = form.properties === undefined ? {} : record(form.properties);
  if (!properties) return fail("The form has no readable fields.");
  const entries = Object.entries(properties);
  if (entries.length > ELICITATION_MAX_FIELDS)
    return fail(`The form has more than ${ELICITATION_MAX_FIELDS} fields.`);
  const required = form.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))
  )
    return fail("The form requires a field it does not define.");
  const fields: ElicitationField[] = [];
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > MAX_KEY_CHARS || RESERVED_KEYS.has(key))
      return fail("The form has a field with an unsupported name.");
    const field = normalizeField(key, value, (required as string[]).includes(key));
    if (!field.ok) return field;
    fields.push(field.value);
  }
  return ok(fields);
}

export interface ElicitationRequestInput {
  readonly mode: string | undefined;
  readonly message: unknown;
  readonly serverName?: unknown;
  readonly title?: unknown;
  readonly nativeId?: unknown;
  readonly requestedSchema?: unknown;
  readonly url?: unknown;
}

/** Builds the value-free descriptor for a provider request, or explains why it is refused. */
export function buildElicitationDescriptor(
  input: ElicitationRequestInput,
): ElicitationResult<ElicitationDescriptor> {
  const message = boundedText(input.message) ?? "";
  const serverName = boundedText(input.serverName);
  const title = boundedText(input.title);
  const nativeId = boundedText(input.nativeId);
  const common = {
    message,
    ...(serverName ? { serverName } : {}),
    ...(title ? { title } : {}),
    ...(nativeId ? { nativeId } : {}),
  };
  if (input.mode === "url") {
    if (typeof input.url !== "string") return fail("The request has no link.");
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return fail("The request link is not a valid URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return fail("The request link must use http or https.");
    if (parsed.username || parsed.password) return fail("The request link embeds credentials.");
    return ok({ ...common, mode: "url", url: parsed.href });
  }
  if (input.mode !== undefined && input.mode !== "form" && input.mode !== "openai/form")
    return fail("The request uses an unsupported mode.");
  const fields = normalizeElicitationSchema(input.requestedSchema ?? { type: "object" });
  if (!fields.ok) return fields;
  return ok({ ...common, mode: "form", fields: fields.value });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validFormat(format: ElicitationStringFormat, value: string): boolean {
  switch (format) {
    case "email":
      return EMAIL.test(value);
    case "uri":
      try {
        return new URL(value).protocol.length > 1;
      } catch {
        return false;
      }
    case "date": {
      const match = DATE.exec(value);
      if (!match) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    }
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  }
}

function validateValue(field: ElicitationField, value: unknown): string | undefined {
  const label = `"${field.title}"`;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `${label} must be yes or no.`;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a number.`;
      if (field.type === "integer" && !Number.isInteger(value))
        return `${label} must be a whole number.`;
      if (field.minimum !== undefined && value < field.minimum)
        return `${label} must be at least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum)
        return `${label} must be at most ${field.maximum}.`;
      return undefined;
    }
    case "enum":
      return typeof value === "string" && field.options?.some((option) => option.value === value)
        ? undefined
        : `${label} must be one of the listed choices.`;
    case "multiselect": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
        return `${label} must be a list of choices.`;
      if (new Set(value).size !== value.length) return `${label} repeats a choice.`;
      if (value.some((entry) => !field.options?.some((option) => option.value === entry)))
        return `${label} must use the listed choices.`;
      if (field.minItems !== undefined && value.length < field.minItems)
        return `${label} needs at least ${field.minItems} choices.`;
      if (field.maxItems !== undefined && value.length > field.maxItems)
        return `${label} allows at most ${field.maxItems} choices.`;
      return undefined;
    }
    case "string": {
      if (typeof value !== "string") return `${label} must be text.`;
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength)
        return `${label} needs at least ${field.minLength} characters.`;
      if (field.maxLength !== undefined && length > field.maxLength)
        return `${label} allows at most ${field.maxLength} characters.`;
      if (field.format && !validFormat(field.format, value))
        return `${label} must be a valid ${field.format}.`;
      return undefined;
    }
  }
}

/**
 * Validates submitted content against the descriptor's fields. Unknown keys
 * are refused, omitted optional fields stay omitted and nothing is defaulted.
 */
export function validateElicitationContent(
  fields: ReadonlyArray<ElicitationField>,
  content: unknown,
): ElicitationResult<Record<string, ElicitationValue>> {
  const values = content === undefined ? {} : record(content);
  if (!values) return fail("The answer is not a form.");
  if (byteLength(values) > ELICITATION_MAX_BYTES) return fail("The answer is too large.");
  const known = new Set(fields.map((field) => field.key));
  if (Object.keys(values).some((key) => !known.has(key)))
    return fail("The answer includes a field the form does not ask for.");
  const result: Record<string, ElicitationValue> = Object.create(null);
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    // An empty text box is an unanswered field; an empty list is an answer.
    if (value === undefined || value === "") {
      if (field.required) return fail(`"${field.title}" is required.`);
      continue;
    }
    const issue = validateValue(field, value);
    if (issue) return fail(issue);
    result[field.key] = value as ElicitationValue;
  }
  return ok(result);
}
