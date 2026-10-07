export type SDKMessage =
  | { type: "assistant" }
  | { type: "system"; subtype: "init" | "informational" };
