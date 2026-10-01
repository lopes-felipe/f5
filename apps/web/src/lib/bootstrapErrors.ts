import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
} from "@t3tools/contracts";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

/** A failed first send whose thread was rolled back (or never created) by the server. */
export function wasBootstrapThreadRolledBack(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === BOOTSTRAP_THREAD_DELETED_ERROR_CODE || code === BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE
  );
}
