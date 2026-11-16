import { Schema } from "effect";

export const McpConfigScope = Schema.Literals(["common", "project"]);
export type McpConfigScope = typeof McpConfigScope.Type;
