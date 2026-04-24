import { createContext, useContext } from "react";
import type { TurnId } from "@t3tools/contracts";

export type FileNavigationHandler = (filePath: string, turnId?: TurnId) => boolean;

const FALLBACK_FILE_NAVIGATION_HANDLER: FileNavigationHandler = () => false;

const FileNavigationContext = createContext<FileNavigationHandler>(
  FALLBACK_FILE_NAVIGATION_HANDLER,
);

export const FileNavigationProvider = FileNavigationContext.Provider;

export function useFileNavigation(): FileNavigationHandler {
  return useContext(FileNavigationContext);
}
