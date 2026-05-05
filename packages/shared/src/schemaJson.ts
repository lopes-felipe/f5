import {
  Cause,
  Effect,
  Exit,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

export const decodeJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeExit(Schema.fromJsonString(schema));
  return (input: string) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const decodeUnknownJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (input: unknown) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const formatSchemaError = (cause: Cause.Cause<Schema.SchemaError>) => {
  const squashed = Cause.squash(cause);
  return Schema.isSchemaError(squashed)
    ? SchemaIssue.makeFormatterDefault()(squashed.issue)
    : Cause.pretty(cause);
};

const parseLenientJsonGetter = SchemaGetter.onSome((input: string) =>
  Effect.try({
    try: () => {
      let stripped = input.replace(
        /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
        (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
      );

      stripped = stripped.replace(
        /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
        (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
      );

      stripped = stripped.replace(/,(\s*[}\]])/g, "$1");
      return Option.some(JSON.parse(stripped));
    },
    catch: (e) => new SchemaIssue.InvalidValue(Option.some(input), { message: String(e) }),
  }),
);

export const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));
