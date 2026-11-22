type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bareAnyOf = (value: unknown): value is { anyOf: unknown[] } =>
  object(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

/** Relax only the advertised schema; handlers retain their full input decoders. */
export function advertisedJsonSchema(schema: JsonObject): JsonObject {
  const compact = (value: unknown, optional = false): unknown => {
    if (Array.isArray(value)) return value.map((child) => compact(child));
    if (!object(value)) return value;
    const required = Array.isArray(value.required) ? value.required : [];
    let result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "$schema" ||
        (key === "additionalProperties" && child === true) ||
        (key === "maximum" && child === Number.MAX_SAFE_INTEGER) ||
        (key === "minimum" && child === Number.MIN_SAFE_INTEGER)
      )
        continue;
      result[key] =
        key === "properties" && object(child)
          ? Object.fromEntries(
              Object.entries(child).map(([name, property]) => [
                name,
                compact(property, !required.includes(name)),
              ]),
            )
          : compact(child);
    }
    if (Array.isArray(result.anyOf)) {
      const original = result.anyOf.flatMap((branch) =>
        bareAnyOf(branch) ? branch.anyOf : [branch],
      );
      const filtered = original.filter(
        (branch) =>
          !(
            object(branch) &&
            ((optional && branch.type === "null" && Object.keys(branch).length === 1) ||
              (branch.type === "string" && branch.contentMediaType === "application/json"))
          ),
      );
      // A nullable-only optional property must remain satisfiable when supplied.
      const branches = filtered.length ? filtered : original;
      const { anyOf: _anyOf, ...rest } = result;
      if (branches.length === 1 && object(branches[0])) result = { ...branches[0], ...rest };
      else {
        // Discriminated branches retain their own required fields and schemas.
        result = { ...rest, anyOf: branches };
      }
    }
    return result;
  };
  return compact(schema) as JsonObject;
}
