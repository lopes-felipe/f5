import type { RuntimePlanStep } from "@t3tools/contracts";
import { Option, Schema } from "effect";

const Todos = Schema.Array(
  Schema.Struct({
    content: Schema.String,
    status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
  }),
);

/** Only a successful, fully recognized native list may replace a checklist. */
export function openCodeTodoPlan(value: unknown): RuntimePlanStep[] | undefined {
  const decoded = Schema.decodeUnknownOption(Todos)(value);
  if (Option.isNone(decoded)) return undefined;
  return decoded.value.flatMap((todo, index) =>
    todo.status === "cancelled"
      ? []
      : [
          {
            step: todo.content.trim() || `Todo ${index + 1}`,
            status:
              todo.status === "completed"
                ? "completed"
                : todo.status === "in_progress"
                  ? "inProgress"
                  : "pending",
          },
        ],
  );
}
