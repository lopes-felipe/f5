export type SDKMessage =
  | { type: "assistant" }
  | { type: "system"; subtype: "new_unclassified_subtype" }
  | { type: "future_message" };
