import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { WsRequestError } from "../wsTransport";
import { wasBootstrapThreadRolledBack } from "./bootstrapErrors";

describe("wasBootstrapThreadRolledBack", () => {
  it("accepts only confirmed bootstrap rollbacks", () => {
    expect(
      wasBootstrapThreadRolledBack(
        new WsRequestError("Worktree failed", BOOTSTRAP_THREAD_DELETED_ERROR_CODE),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadRolledBack(
        new WsRequestError("Not a repo", BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE),
      ),
    ).toBe(true);
    expect(wasBootstrapThreadRolledBack(new WsRequestError("Ambiguous"))).toBe(false);
    expect(wasBootstrapThreadRolledBack(new Error("connection lost"))).toBe(false);
    expect(wasBootstrapThreadRolledBack(undefined)).toBe(false);
  });
});
