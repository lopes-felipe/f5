import { createContext } from "react";
import type { ProjectIssueAssetUrlInput } from "@t3tools/contracts";

/** Relative Markdown media uses a fresh exact-file grant, never an HTML directory grant. */
export const AssetDocumentContext = createContext<{
  identity: ProjectIssueAssetUrlInput["identity"];
  relativePath: string;
} | null>(null);
