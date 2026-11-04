import { expect, it } from "vitest";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { prHubPeekErrorCode } from "./prHubPeekError.ts";

it.each([
  ["unauthenticated", "PrHubAccountRequired"],
  ["forbidden", "PrHubAccessDenied"],
  ["network", undefined],
] as const)("maps forge %s errors without guessing from their message", (kind, expected) => {
  expect(
    prHubPeekErrorCode(
      new SourceControlProviderError({
        provider: "github",
        operation: "getDetail",
        kind,
        detail: "Forbidden account changed",
      }),
    ),
  ).toBe(expected);
});
