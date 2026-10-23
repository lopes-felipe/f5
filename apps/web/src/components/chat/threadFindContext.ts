import { createContext } from "react";
export const ThreadFindContext = createContext<{
  entryId: string;
  query: string;
  occurrence: number;
} | null>(null);
