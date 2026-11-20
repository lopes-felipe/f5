type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bareAnyOf = (value: unknown): value is { anyOf: unknown[] } =>
  object(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;
const tagOf = (branch: JsonObject, key: string) => {
  const property = object(branch.properties) ? branch.properties[key] : undefined;
  if (!object(property)) return undefined;
  return (
    property.const ??
    (Array.isArray(property.enum) && property.enum.length === 1 ? property.enum[0] : undefined)
  );
};

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
      const branches = result.anyOf
        .flatMap((branch) => (bareAnyOf(branch) ? branch.anyOf : [branch]))
        .filter(
          (branch) =>
            !(
              object(branch) &&
              ((optional && branch.type === "null" && Object.keys(branch).length === 1) ||
                (branch.type === "string" && branch.contentMediaType === "application/json"))
            ),
        );
      const { anyOf: _anyOf, ...rest } = result;
      if (branches.length === 1 && object(branches[0])) result = { ...branches[0], ...rest };
      else {
        const objects = branches.filter(
          (branch): branch is JsonObject =>
            object(branch) && branch.type === "object" && object(branch.properties),
        );
        const first = objects[0];
        const tag =
          first && objects.length === branches.length && objects.length > 1
            ? Object.keys(first.properties as JsonObject).find((key) => {
                const tags = objects.map((branch) => tagOf(branch, key));
                return (
                  tags.every((value) => typeof value === "string") &&
                  new Set(tags).size === tags.length
                );
              })
            : undefined;
        if (!tag) return { ...rest, anyOf: branches };
        const properties: JsonObject = {
          [tag]: { type: "string", enum: objects.map((branch) => tagOf(branch, tag)) },
        };
        for (const branch of objects)
          for (const [name, property] of Object.entries(branch.properties as JsonObject)) {
            if (name === tag) continue;
            const previous = properties[name];
            if (previous === undefined) properties[name] = property;
            else if (JSON.stringify(previous) !== JSON.stringify(property)) {
              const options = bareAnyOf(previous) ? previous.anyOf : [previous];
              if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
                properties[name] = { anyOf: [...options, property] };
            }
          }
        const common = Array.isArray(first?.required)
          ? first.required.filter(
              (name) =>
                name !== tag &&
                objects.every(
                  (branch) => Array.isArray(branch.required) && branch.required.includes(name),
                ),
            )
          : [];
        result = { type: "object", properties, required: [tag, ...common], ...rest };
      }
    }
    return result;
  };
  return compact(schema) as JsonObject;
}
