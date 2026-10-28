import { createContext } from "react";
export const ThreadFindContext = createContext<{
  entryId: string;
  query: string;
  occurrence: number;
  /** The navigation request that selected this match; reported back with its range. */
  requestId?: number | null;
  /** Called once per request with the active range, after the row has committed. */
  onSelectedRange?: ((requestId: number, range: Range) => void) | undefined;
} | null>(null);
