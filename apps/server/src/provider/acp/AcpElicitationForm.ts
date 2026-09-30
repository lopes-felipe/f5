import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type {
  ElicitationRequest,
  ElicitationResponse,
  ElicitationContentValue,
} from "effect-acp/schema";

/** Represent every field, never accept invisible defaults or unsupported constraints. */
export function acpElicitationForm(request: ElicitationRequest) {
  if (request.mode !== "form") return undefined;
  const fields = Object.entries(request.requestedSchema.properties ?? {});
  if (
    !fields.length ||
    fields.length > 32 ||
    fields.some(
      ([key, field]) =>
        !key.trim() ||
        field.type === "array" ||
        (field.type === "string" && (field.pattern || field.format)),
    )
  )
    return undefined;
  const required = new Set(request.requestedSchema.required ?? []);
  if ([...required].some((key) => !fields.some(([name]) => name === key))) return undefined;
  const questions: UserInputQuestion[] = fields.map(([key, field]) => {
    const choices =
      field.type === "boolean"
        ? ["Yes", "No"]
        : field.type === "string"
          ? (field.enum ?? field.oneOf?.map((option) => option.const) ?? [])
          : [];
    return {
      id: key,
      header: field.title?.trim() || key,
      question: [
        request.message,
        field.description || field.title || key,
        required.has(key) ? "Required" : "Optional",
      ].join("\n\n"),
      multiSelect: false,
      optional: !required.has(key),
      options: choices.map((choice) => ({ label: choice, description: choice })),
    };
  });
  if (questions.some((question) => question.options.some((option) => !option.label.trim())))
    return undefined;
  const respond = (answers: ProviderUserInputAnswers): ElicitationResponse | undefined => {
    if (!Object.keys(answers).length) return { action: { action: "cancel" } };
    const content: Record<string, ElicitationContentValue> = Object.create(null);
    for (const [key, field] of fields) {
      const raw = answers[key];
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string"
            ? raw[0]
            : undefined;
      if (text === undefined || text === "") {
        if (required.has(key)) return undefined;
        continue;
      }
      if (field.type === "boolean") {
        if (text !== "Yes" && text !== "No") return undefined;
        content[key] = text === "Yes";
      } else if (field.type === "number" || field.type === "integer") {
        const number = Number(text);
        if (
          !text.trim() ||
          !Number.isFinite(number) ||
          (field.type === "integer" && !Number.isInteger(number)) ||
          (field.minimum != null && number < field.minimum) ||
          (field.maximum != null && number > field.maximum)
        )
          return undefined;
        content[key] = number;
      } else if (field.type === "string") {
        const choices = field.enum ?? field.oneOf?.map((option) => option.const);
        if (
          (choices && !choices.includes(text)) ||
          (field.minLength != null && text.length < field.minLength) ||
          (field.maxLength != null && text.length > field.maxLength)
        )
          return undefined;
        content[key] = text;
      } else return undefined;
    }
    return { action: { action: "accept", content } };
  };
  return { questions, respond };
}
